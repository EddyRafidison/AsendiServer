"use strict";

const BigNumber = require("bignumber.js");
const {
  calculateGlobalUnitPrice,
  calculateRemainingSystemAdminReserve,
} = require("./stock-accounting");

const PUBLIC_RECHARGE_SNAPSHOT_SQL = `
  SELECT
    c.total_units_price,
    c.unit_price,
    c.backed_units,
    c.inactive_init_asset,
    c.sys_inactive_init_asset,
    c.sellers_res,
    COALESCE((
      SELECT SUM(l.remaining_initial_asset)
      FROM users_seller_reserve_lots l
      INNER JOIN users_seller_campaigns sc ON sc.id=l.campaign_id
      WHERE l.status='active' AND sc.status='active' AND l.remaining_initial_asset>0
    ), 0) AS active_seller_initial_asset,
    COALESCE((
      SELECT SUM(d.sold_initial_asset)
      FROM users_usdt_disbursements d
      WHERE d.status IN ('queued','signed','submitted','manual_review')
    ), 0) AS pending_disbursement_initial_asset
  FROM common c
  ORDER BY c.id DESC
  LIMIT 1
`;

function asFiniteNonNegative(value, fieldName) {
  const amount = new BigNumber(value);
  if (!amount.isFinite() || amount.isNegative()) {
    throw new RangeError(`${fieldName} must be finite and non-negative`);
  }
  return amount;
}

/**
 * Calculate the public reserve capacity available to fund new recharges.
 * All reserve components and pending reservations are initial assets; the
 * combined free amount is converted to public XTU at the current global price.
 * The remaining administrative quota is excluded from backed_units.
 */
function calculateAvailableRechargeReserveXtu({
  totalUnitsPrice,
  unitPrice,
  backedUnits,
  inactiveInitialAsset,
  sysInactiveInitialAsset,
  totalSellerReserve,
  activeSellerInitialAsset,
  pendingDisbursementInitialAsset = 0,
  stockLimit,
  adminReserveRatio,
}) {
  const total = asFiniteNonNegative(totalUnitsPrice, "common.total_units_price");
  const price = asFiniteNonNegative(unitPrice, "common.unit_price");
  const backed = asFiniteNonNegative(backedUnits, "common.backed_units");
  const inactive = asFiniteNonNegative(inactiveInitialAsset, "common.inactive_init_asset");
  const spentAdmin = asFiniteNonNegative(sysInactiveInitialAsset, "common.sys_inactive_init_asset");
  const sellerLedger = asFiniteNonNegative(totalSellerReserve, "common.sellers_res");
  const activeSellers = asFiniteNonNegative(activeSellerInitialAsset, "active seller reserve lots");
  const pendingDisbursements = asFiniteNonNegative(
    pendingDisbursementInitialAsset,
    "pending disbursement initial assets",
  );

  if (!total.isGreaterThan(0) || !backed.isGreaterThan(0) || !price.isGreaterThan(0)) {
    throw new RangeError("Global reserve totals and unit price must be positive");
  }
  if (activeSellers.isGreaterThan(sellerLedger)) {
    throw new RangeError("Active seller lots exceed common.sellers_res");
  }

  const verifiedPrice = calculateGlobalUnitPrice(total, backed);
  if (verifiedPrice.minus(price).gt("0.000000000000000000000000000001")) {
    throw new RangeError("common.unit_price must not be below common.total_units_price / common.backed_units");
  }

  const adminReserve = calculateRemainingSystemAdminReserve(
    stockLimit,
    adminReserveRatio,
    spentAdmin,
  );
  if (backed.isLessThan(adminReserve.remainingInitialAsset)) {
    throw new RangeError("common.backed_units is below the remaining administrative reserve quota");
  }

  const distributableBacked = backed.minus(adminReserve.remainingInitialAsset);
  const grossSystemReserve = inactive.plus(distributableBacked);
  const unreservedSystemReserve = BigNumber.maximum(
    0,
    grossSystemReserve.minus(pendingDisbursements),
  );
  const totalAvailableInitialAsset = activeSellers.plus(unreservedSystemReserve);
  const totalAvailableXtu = totalAvailableInitialAsset.multipliedBy(price);

  return {
    availableReserveXtu: totalAvailableXtu,
    availableInitialAsset: totalAvailableInitialAsset,
    distributableBackedInitialAsset: distributableBacked,
    availableSystemInitialAsset: unreservedSystemReserve,
    availableSellerInitialAsset: activeSellers,
    remainingAdministrativeInitialAsset: adminReserve.remainingInitialAsset,
    pendingDisbursementInitialAsset: pendingDisbursements,
    unitPrice: price,
  };
}

/**
 * Build a shared, short-lived cache so clients can poll once per second
 * without making each request scan reserve tables or lock financial rows.
 */
function createRechargeAvailabilityCache({ ttlMs = 1000, now = Date.now } = {}) {
  if (!Number.isInteger(ttlMs) || ttlMs < 100) {
    throw new RangeError("Recharge availability cache TTL must be at least 100 milliseconds");
  }

  let cached = null;
  let cachedAtMs = 0;
  let inFlight = null;
  let cachedKey = null;

  async function get(db, options) {
    const key = [
      options.stockLimit,
      String(options.adminReserveRatio),
    ].join("|");
    const currentTime = now();
    if (cached && cachedKey === key && currentTime - cachedAtMs < ttlMs) {
      return cached;
    }
    if (inFlight) return inFlight;

    inFlight = (async () => {
      const rows = await db.queryAsync(PUBLIC_RECHARGE_SNAPSHOT_SQL);
      if (!Array.isArray(rows) || rows.length === 0) {
        throw new Error("The common reserve snapshot is not initialized");
      }
      const row = rows[0];
      const calculated = calculateAvailableRechargeReserveXtu({
        totalUnitsPrice: row.total_units_price,
        unitPrice: row.unit_price,
        backedUnits: row.backed_units,
        inactiveInitialAsset: row.inactive_init_asset,
        sysInactiveInitialAsset: row.sys_inactive_init_asset,
        totalSellerReserve: row.sellers_res,
        activeSellerInitialAsset: row.active_seller_initial_asset,
        pendingDisbursementInitialAsset: row.pending_disbursement_initial_asset,
        stockLimit: options.stockLimit,
        adminReserveRatio: options.adminReserveRatio,
      });

      return Object.freeze({
        availableReserveXtu: calculated.availableReserveXtu.toFixed(18),
      });
    })();

    try {
      const result = await inFlight;
      cached = result;
      cachedAtMs = now();
      cachedKey = key;
      return result;
    } finally {
      inFlight = null;
    }
  }

  function invalidate() {
    cached = null;
    cachedAtMs = 0;
    cachedKey = null;
  }

  return { get, invalidate };
}

const publicRechargeAvailabilityCache = createRechargeAvailabilityCache({ ttlMs: 1000 });

async function getPublicRechargeAvailability(db, options) {
  return publicRechargeAvailabilityCache.get(db, options);
}

module.exports = {
  PUBLIC_RECHARGE_SNAPSHOT_SQL,
  calculateAvailableRechargeReserveXtu,
  createRechargeAvailabilityCache,
  getPublicRechargeAvailability,
};
