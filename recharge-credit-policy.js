"use strict";

const BigNumber = require("bignumber.js");
const {
  calculateGlobalUnitPrice,
  calculateRechargeFundingAllocation,
  isUserBalanceWithinMaxStock,
} = require("./stock-accounting");

const CREDIT_DECIMALS = 18;
const CREDIT_ROUNDING = BigNumber.ROUND_DOWN;

function asAmount(value, name) {
  const amount = new BigNumber(value);
  if (!amount.isFinite() || amount.isNegative()) {
    throw new RangeError(`${name} must be a finite non-negative amount`);
  }
  return amount;
}

function evaluateRechargeCredit({
  grossAmount,
  currentBalanceInitialAsset,
  totalUnitsPrice,
  backedUnits,
  inactiveInitialAsset,
  totalSellerReserve,
  availableSellerReserve,
  protectedAdminInitialAsset,
  pendingDisbursementInitialAsset = 0,
  currentUnitPrice,
  tfeesRatePercent,
  maximumUserXtu = "300",
  weeklyCooldownAllowed = true,
  globalBonusRatePercent = 0,
  remainingAdminReserveInitialAsset = 0,
  alreadyReservedAdminBonusInitialAsset = 0,
  stockLimitEvaluator = null,
}) {
  const gross = asAmount(grossAmount, "Recharge gross amount");
  const balance = asAmount(currentBalanceInitialAsset, "User balance");
  const total = asAmount(totalUnitsPrice, "Common total units price");
  const backed = asAmount(backedUnits, "Common backed units");
  const inactive = asAmount(inactiveInitialAsset, "Common inactive initial assets");
  const sellers = asAmount(totalSellerReserve, "Common seller reserve");
  const activeSellers = asAmount(availableSellerReserve, "Available seller reserve");
  const protectedFloor = asAmount(protectedAdminInitialAsset, "Protected administrative reserve");
  const pendingPayouts = asAmount(pendingDisbursementInitialAsset, "Pending disbursement reserve");
  const price = asAmount(currentUnitPrice, "Common unit price");
  const feeRate = asAmount(tfeesRatePercent, "Recharge tfees rate");
  const maximumXtu = asAmount(maximumUserXtu, "Maximum user XTU");
  const bonusRate = asAmount(globalBonusRatePercent, "Global bonus rate");
  const remainingAdmin = asAmount(remainingAdminReserveInitialAsset, "Remaining administrative reserve");
  const reservedBonus = asAmount(alreadyReservedAdminBonusInitialAsset, "Reserved global bonus");

  if (!gross.isGreaterThan(0) || !total.isGreaterThan(0) || !backed.isGreaterThan(0) ||
      !price.isGreaterThan(0) || !maximumXtu.isGreaterThan(0) || feeRate.isGreaterThanOrEqualTo(100) ||
      bonusRate.isGreaterThan(10) || activeSellers.gt(sellers) || backed.lt(protectedFloor)) {
    throw new RangeError("Recharge credit inputs are outside their valid ranges");
  }

  const currentPrice = calculateGlobalUnitPrice(total, backed);
  if (currentPrice.minus(price).abs().gt("0.000000000000000000000000000001")) {
    throw new RangeError("Current XTU price is inconsistent with common reserve values");
  }

  const feeAmount = gross.multipliedBy(feeRate).dividedBy(100);
  const netAmount = gross.minus(feeAmount);
  if (!netAmount.isGreaterThan(0)) return { allowed: false, reason: "fees_exhaust_amount" };

  const requestedInitialAsset = netAmount.dividedBy(price);
  const allocation = calculateRechargeFundingAllocation(
    requestedInitialAsset,
    price,
    backed,
    inactive,
    activeSellers,
    total,
    protectedFloor,
    pendingPayouts,
  );
  if (!allocation.available) {
    return {
      allowed: false,
      reason: "system_reserve",
      availableInitialAsset: allocation.availableAfterPending,
      requestedInitialAsset,
    };
  }

  const systemAmountXtu = allocation.systemInitialAsset.multipliedBy(price);
  if (systemAmountXtu.isGreaterThan(0) && weeklyCooldownAllowed !== true) {
    return { allowed: false, reason: "weekly_limit", allocation };
  }

  const feeBasis = feeAmount.dividedBy(price);
  const newTotal = total.plus(systemAmountXtu).plus(feeAmount);
  const newBacked = backed.minus(allocation.consumedBacked).plus(feeBasis);
  if (!newBacked.isGreaterThan(0) || newBacked.lt(protectedFloor)) {
    return { allowed: false, reason: "system_reserve", allocation };
  }
  const newPrice = calculateGlobalUnitPrice(newTotal, newBacked);
  const stockLimit = typeof stockLimitEvaluator === "function"
    ? stockLimitEvaluator(balance, requestedInitialAsset, newPrice)
    : isUserBalanceWithinMaxStock(balance, requestedInitialAsset, newPrice, maximumXtu);
  if (!stockLimit.allowed) {
    return {
      allowed: false,
      reason: "maximum_user_balance",
      projectedBalanceXtu: stockLimit.projectedXtu,
      allocation,
    };
  }

  const additionalAdminBonusReserve = requestedInitialAsset.multipliedBy(bonusRate).dividedBy(100);
  const freeAdminReserve = remainingAdmin.minus(reservedBonus);
  if (additionalAdminBonusReserve.gt(freeAdminReserve)) {
    return { allowed: false, reason: "global_bonus_reserve", allocation };
  }

  return {
    allowed: true,
    reason: null,
    grossAmount: gross,
    feeAmount,
    netAmount,
    requestedInitialAsset,
    allocation,
    systemAmountXtu,
    feeBasis,
    newTotal,
    newBacked,
    newInactive: allocation.newInactive,
    newSellerReserve: sellers.minus(allocation.sellerInitialAsset),
    newPrice,
    projectedBalanceXtu: stockLimit.projectedXtu,
    additionalAdminBonusReserve,
    sellerInitialAsset: allocation.sellerInitialAsset,
    systemInitialAsset: allocation.systemInitialAsset,
  };
}

function findMaximumRechargeCredit(options) {
  const target = asAmount(options.targetGrossAmount, "Target recharge amount");
  if (!target.isGreaterThan(0)) return { allowed: false, reason: "invalid_amount" };

  const evaluate = (gross) => evaluateRechargeCredit({ ...options, grossAmount: gross });
  const full = evaluate(target);
  if (full.allowed) return { ...full, partial: false, targetGrossAmount: target };

  let low = new BigNumber(0);
  let high = target;
  let best = null;
  for (let iteration = 0; iteration < 72; iteration += 1) {
    const midpoint = low.plus(high).dividedBy(2).decimalPlaces(CREDIT_DECIMALS, CREDIT_ROUNDING);
    if (!midpoint.isGreaterThan(low) || !midpoint.isLessThan(high)) break;
    const candidate = evaluate(midpoint);
    if (candidate.allowed) {
      low = midpoint;
      best = candidate;
    } else {
      high = midpoint;
    }
  }

  if (!best || !low.isGreaterThan(0)) {
    return {
      allowed: false,
      reason: full.reason,
      details: full,
      targetGrossAmount: target,
    };
  }

  return {
    ...best,
    partial: low.lt(target),
    partialReason: full.reason,
    targetGrossAmount: target,
  };
}

module.exports = {
  CREDIT_DECIMALS,
  evaluateRechargeCredit,
  findMaximumRechargeCredit,
};
