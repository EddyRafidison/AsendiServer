"use strict";

const crypto = require("crypto");
const BigNumber = require("bignumber.js");
const {
  REFUND_ELIGIBILITY_DELAY_MS,
  MINIMUM_AUTOMATIC_REFUND_NET,
  MAXIMUM_REFUND_GAS_EQUIVALENT,
  calculateRefundEventFee,
  getAutomaticRefundGroupKey,
} = require("./automatic-refund-policy");

const ZERO = new BigNumber(0);
const ONE = new BigNumber(1);
const OUTSTANDING_EVENT_STATES = new Set([
  "collecting", "eligible", "reserved", "queued", "signed", "submitted", "manual_review",
]);
const ACTIVE_PAYOUT_STATES = ["queued", "signed", "submitted", "manual_review"];
const ADDRESS_RE = /^0x[0-9a-f]{40}$/;
const HASH_RE = /^0x[0-9a-f]{64}$/;

function bn(value, name, allowZero = true) {
  const result = new BigNumber(String(value ?? "0"));
  if (!result.isFinite() || (allowZero ? result.isNegative() : !result.isGreaterThan(0))) {
    throw new RangeError(`${name} must be ${allowZero ? "finite and non-negative" : "finite and positive"}.`);
  }
  return result.decimalPlaces(18, BigNumber.ROUND_DOWN);
}

function address(value, name) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!ADDRESS_RE.test(normalized) || /^0x0{40}$/.test(normalized)) {
    throw new TypeError(`${name} must be a valid non-zero EVM address.`);
  }
  return normalized;
}

function timestamp(value, name) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result <= 0) throw new RangeError(`${name} must be a positive safe timestamp.`);
  return result;
}

function createReference(prefix = "ARF") {
  return `${prefix}-${crypto.randomBytes(16).toString("hex").toUpperCase()}`;
}

function hashIdentity(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

async function ensureWalletFinancialLockTx(tx, walletAddress, nowMs = Date.now()) {
  const wallet = address(walletAddress, "wallet_address");
  const now = String(timestamp(nowMs, "nowMs"));
  await tx.query(
    `INSERT IGNORE INTO bsc_wallet_financial_locks(wallet_address_lower,created_at_ms,updated_at_ms)
     VALUES(?,?,?)`, [wallet, now, now],
  );
  const [rows] = await tx.query(
    `SELECT wallet_address_lower FROM bsc_wallet_financial_locks
     WHERE wallet_address_lower=? LIMIT 1 FOR UPDATE`, [wallet],
  );
  if (!rows.length) throw new Error("Unable to acquire the BSC wallet financial lock.");
  await tx.query(
    "UPDATE bsc_wallet_financial_locks SET updated_at_ms=? WHERE wallet_address_lower=?",
    [now, wallet],
  );
  return wallet;
}

async function recalculateGroupTotalsTx(tx, groupId, nowMs = Date.now()) {
  const now = String(timestamp(nowMs, "nowMs"));
  const [rows] = await tx.query(
    `SELECT
       COALESCE(SUM(CASE WHEN source_kind<>'gas_adjustment' THEN gross_amount ELSE 0 END),0) AS gross_total,
       COALESCE(SUM(CASE WHEN source_kind<>'gas_adjustment' THEN refund_fee_amount ELSE 0 END),0) AS fee_total,
       COALESCE(SUM(CASE WHEN status NOT IN ('refunded','resolved','cancelled') THEN gross_amount-refunded_amount ELSE 0 END),0) AS outstanding_gross,
       MIN(CASE WHEN status NOT IN ('refunded','resolved','cancelled') THEN refund_eligible_at_ms ELSE NULL END) AS next_eligible
     FROM automatic_refund_group_events WHERE group_id=?`, [String(groupId)],
  );
  const aggregate = rows[0] || {};
  await tx.query(
    `UPDATE automatic_refund_groups
     SET total_gross_received=?,total_refund_fee=?,next_eligible_at_ms=COALESCE(?,next_eligible_at_ms),updated_at_ms=?
     WHERE id=?`,
    [String(aggregate.gross_total || "0"), String(aggregate.fee_total || "0"),
      aggregate.next_eligible == null ? null : String(aggregate.next_eligible), now, String(groupId)],
  );
  return aggregate;
}

/**
 * Registers one immutable, already-finalized source transfer in its exclusive
 * refund group. Caller must own the SQL transaction and pass the exact token
 * contract, source row and finality evidence.
 */
async function registerAutomaticRefundEventTx(tx, input) {
  const chainId = Number(input.chainId);
  if (chainId !== 56) throw new RangeError("Automatic refunds are restricted to BNB Smart Chain Mainnet (chain ID 56).");
  const assetCode = String(input.assetCode || "").trim().toUpperCase();
  if (!new Set(["BSC-USD", "XTU"]).has(assetCode)) throw new TypeError("Unsupported automatic refund asset.");
  const tokenContract = address(input.tokenContract, "token_contract");
  const senderAddress = address(input.senderAddress, "sender_address");
  const payoutAddress = address(input.payoutAddress || input.senderAddress, "payout_address");
  if (payoutAddress !== senderAddress) throw new RangeError("The automatic refund destination must be the verified source address.");
  const grossAmount = bn(input.grossAmount, "grossAmount", false);
  const finalizedAtMs = timestamp(input.finalizedAtMs, "finalizedAtMs");
  const refundEligibleAtMs = finalizedAtMs + REFUND_ELIGIBILITY_DELAY_MS;
  const sourceTable = String(input.sourceTable || "").trim();
  const sourceKind = String(input.sourceKind || "").trim();
  const sourceId = String(input.sourceId || "").trim();
  const eventIdentity = String(input.eventIdentity || "").trim().toLowerCase();
  const txHash = String(input.txHash || "").trim().toLowerCase();
  const blockHash = String(input.blockHash || "").trim().toLowerCase();
  const blockNumber = String(input.blockNumber || "").trim();
  const logIndex = Number(input.logIndex);
  if (!/^[a-z0-9_]{2,64}$/i.test(sourceTable) || !/^[a-z0-9_]{2,32}$/i.test(sourceKind) || !/^\d{1,20}$/.test(sourceId)) {
    throw new TypeError("Invalid automatic refund source reference.");
  }
  if (!/^[0-9a-f]{64}$/.test(eventIdentity) || !HASH_RE.test(txHash) || !HASH_RE.test(blockHash) ||
      !/^\d{1,24}$/.test(blockNumber) || !Number.isSafeInteger(logIndex) || logIndex < 0) {
    throw new TypeError("The source event identity and finality proof are invalid.");
  }
  const category = String(input.category || "").trim().toUpperCase();
  if (!new Set(["A", "B", "C", "D"]).has(category)) throw new TypeError("Invalid automatic refund category.");
  const now = timestamp(input.nowMs ?? Date.now(), "nowMs");
  await ensureWalletFinancialLockTx(tx, senderAddress, now);

  const groupKey = getAutomaticRefundGroupKey({ chainId, tokenContract, assetCode, senderAddress });
  const [existingSource] = await tx.query(
    `SELECT id,group_id,status FROM automatic_refund_group_events
     WHERE source_table=? AND source_id=? LIMIT 1 FOR UPDATE`, [sourceTable, sourceId],
  );
  if (existingSource.length) {
    if (String(existingSource[0].status) === "manual_review") {
      return { status: "manual_review", duplicate: true, groupId: String(existingSource[0].group_id) };
    }
    return { status: "duplicate", duplicate: true, groupId: String(existingSource[0].group_id) };
  }

  const reference = createReference();
  await tx.query(
    `INSERT IGNORE INTO automatic_refund_groups
     (reference,chain_id,token_contract,asset_code,sender_address,payout_address,username,categories_json,
      total_gross_received,total_refund_fee,gas_estimated_amount,gas_actual_amount,net_estimated_amount,
      net_paid_amount,residual_amount,status,first_event_at_ms,last_event_at_ms,next_eligible_at_ms,created_at_ms,updated_at_ms)
     VALUES(?,?,?,?,?,?,?, ?,0,0,0,0,0,0,0,'collecting',?,?,?, ?,?)`,
    [reference, String(chainId), tokenContract, assetCode, senderAddress, payoutAddress,
      input.username ? String(input.username).slice(0, 30) : null, JSON.stringify([category]),
      String(finalizedAtMs), String(finalizedAtMs), String(refundEligibleAtMs), String(now), String(now)],
  );
  const [groupRows] = await tx.query(
    `SELECT * FROM automatic_refund_groups
     WHERE chain_id=? AND token_contract=? AND asset_code=? AND sender_address=? LIMIT 1 FOR UPDATE`,
    [String(chainId), tokenContract, assetCode, senderAddress],
  );
  if (!groupRows.length) throw new Error("The automatic refund group could not be created or locked.");
  const group = groupRows[0];
  let categories = [];
  try { categories = JSON.parse(String(group.categories_json || "[]")); } catch { categories = []; }
  if (!Array.isArray(categories)) categories = [];
  if (!categories.includes(category)) categories.push(category);

  const refundFee = calculateRefundEventFee(grossAmount);
  const netReceived = BigNumber.maximum(ZERO, grossAmount.minus(refundFee)).decimalPlaces(18, BigNumber.ROUND_DOWN);
  const [insertResult] = await tx.query(
    `INSERT IGNORE INTO automatic_refund_group_events
     (group_id,source_table,source_id,source_kind,event_identity,chain_id,token_contract,asset_code,
      sender_address,payout_address,tx_hash,log_index,block_number,block_hash,gross_amount,refund_fee_amount,
      net_received_amount,reserved_amount,refunded_amount,residual_amount,finalized_at_ms,refund_eligible_at_ms,
      status,reason_code,created_at_ms,updated_at_ms)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,0,0,?,?, 'collecting',?,?,?)`,
    [String(group.id), sourceTable, sourceId, sourceKind, eventIdentity, String(chainId), tokenContract, assetCode,
      senderAddress, payoutAddress, txHash, String(logIndex), blockNumber, blockHash,
      grossAmount.toFixed(18), refundFee.toFixed(18), netReceived.toFixed(18), String(finalizedAtMs),
      String(refundEligibleAtMs), String(input.reasonCode || `category_${category.toLowerCase()}`), String(now), String(now)],
  );
  if (Number(insertResult.affectedRows || 0) !== 1) {
    const [duplicateRows] = await tx.query(
      `SELECT id,group_id FROM automatic_refund_group_events WHERE event_identity=? LIMIT 1 FOR UPDATE`, [eventIdentity],
    );
    return { status: "duplicate", duplicate: true, groupId: duplicateRows[0] ? String(duplicateRows[0].group_id) : String(group.id) };
  }
  await tx.query(
    `UPDATE automatic_refund_groups SET categories_json=?,username=COALESCE(username,?),
     first_event_at_ms=LEAST(first_event_at_ms,?),last_event_at_ms=GREATEST(last_event_at_ms,?),
     gas_estimated_amount=IF(status='completed',0,gas_estimated_amount),
     net_estimated_amount=IF(status='completed',0,net_estimated_amount),
     status=CASE WHEN status='completed' THEN 'collecting' ELSE status END,updated_at_ms=? WHERE id=?`,
    [JSON.stringify(categories), input.username ? String(input.username).slice(0, 30) : null,
      String(finalizedAtMs), String(finalizedAtMs), String(now), String(group.id)],
  );
  await recalculateGroupTotalsTx(tx, group.id, now);
  return { status: "registered", duplicate: false, groupId: String(group.id), eventId: String(insertResult.insertId), groupKey };
}

async function getOutstandingRefundObligationsTx(tx, walletAddress, nowMs = Date.now()) {
  const wallet = address(walletAddress, "wallet_address");
  const now = timestamp(nowMs, "nowMs");
  const [groups] = await tx.query(
    `SELECT * FROM automatic_refund_groups WHERE sender_address=? ORDER BY asset_code,token_contract,id`, [wallet],
  );
  const details = [];
  const totalsMap = new Map();
  for (const group of groups) {
    const [events] = await tx.query(
      `SELECT * FROM automatic_refund_group_events WHERE group_id=?
       AND status NOT IN ('refunded','resolved','cancelled') ORDER BY finalized_at_ms,id`, [String(group.id)],
    );
    const [payoutRows] = await tx.query(
      `SELECT * FROM automatic_refund_payouts WHERE group_id=? AND status IN ('${ACTIVE_PAYOUT_STATES.join("','")}')
       ORDER BY id DESC LIMIT 1`, [String(group.id)],
    );
    if (!events.length && !payoutRows.length && String(group.status) === "completed") continue;
    let pendingGross = ZERO;
    let eligibleGross = ZERO;
    let eligibleFee = ZERO;
    let projectedGross = ZERO;
    let projectedFee = ZERO;
    let nextEligibleAt = null;
    let manualReview = String(group.status) === "manual_review" || payoutRows.some((p) => String(p.status) === "manual_review");
    for (const event of events) {
      if (String(event.status) === "manual_review") manualReview = true;
      const remainingGross = BigNumber.maximum(ZERO, bn(event.gross_amount).minus(event.refunded_amount || "0"));
      if (remainingGross.isZero()) continue;
      pendingGross = pendingGross.plus(remainingGross);
      projectedGross = projectedGross.plus(remainingGross);
      projectedFee = projectedFee.plus(bn(event.refund_fee_amount || "0"));
      const eligibleAt = Number(event.refund_eligible_at_ms);
      if (Number.isSafeInteger(eligibleAt) && eligibleAt <= now) {
        eligibleGross = eligibleGross.plus(remainingGross);
        eligibleFee = eligibleFee.plus(bn(event.refund_fee_amount || "0"));
      } else if (Number.isSafeInteger(eligibleAt)) {
        nextEligibleAt = nextEligibleAt == null ? eligibleAt : Math.min(nextEligibleAt, eligibleAt);
      }
    }
    // Before a fresh gas quote exists, use the configured ceiling as a
    // conservative projection; lack of a quote is not a manual-review case.
    const gas = bn(payoutRows[0]?.gas_estimated_amount ??
      (bn(group.gas_estimated_amount || "0").isGreaterThan(0)
        ? group.gas_estimated_amount : MAXIMUM_REFUND_GAS_EQUIVALENT));
    const eligibleNet = BigNumber.maximum(ZERO, eligibleGross.minus(eligibleFee).minus(gas));
    const projectedNet = BigNumber.maximum(ZERO, projectedGross.minus(projectedFee).minus(gas));
    const hasUncertain = payoutRows.some((p) => ["signed", "submitted", "manual_review"].includes(String(p.status)));
    const nextAction = manualReview || hasUncertain
      ? "WAIT_FOR_REFUND_RESOLUTION"
      : projectedNet.gte(ONE) ? "WAIT_FOR_REFUND_COMPLETION" : "COMPLETE_MINIMUM_REQUIRED";
    const entry = {
      group_id: String(group.id),
      asset_code: String(group.asset_code),
      token_contract: String(group.token_contract).toLowerCase(),
      pending_gross_amount: pendingGross.toFixed(18),
      net_amount_currently_eligible: eligibleNet.toFixed(18),
      estimated_net_refund_amount: projectedNet.toFixed(18),
      minimum_net_amount: MINIMUM_AUTOMATIC_REFUND_NET.toFixed(18),
      additional_net_amount_required: BigNumber.maximum(ZERO, ONE.minus(projectedNet)).toFixed(18),
      refund_status: String(group.status),
      next_eligible_at_ms: nextEligibleAt,
      next_action: nextAction,
    };
    details.push(entry);
    const totalKey = `${entry.asset_code}:${entry.token_contract}`;
    const total = totalsMap.get(totalKey) || { asset_code: entry.asset_code, token_contract: entry.token_contract, pending_gross_amount: ZERO };
    total.pending_gross_amount = total.pending_gross_amount.plus(pendingGross);
    totalsMap.set(totalKey, total);
  }
  return {
    hasPending: details.some((item) => new BigNumber(item.pending_gross_amount).isGreaterThan(0) ||
      !["completed", "resolved"].includes(item.refund_status)),
    pending_totals_by_asset: [...totalsMap.values()].map((item) => ({
      asset_code: item.asset_code,
      token_contract: item.token_contract,
      pending_gross_amount: item.pending_gross_amount.toFixed(18),
    })),
    pending_refunds: details,
  };
}

async function reserveAutomaticRefundPayoutTx(tx, groupId, quote, nowMs = Date.now()) {
  const now = timestamp(nowMs, "nowMs");
  const [groupRows] = await tx.query("SELECT * FROM automatic_refund_groups WHERE id=? LIMIT 1 FOR UPDATE", [String(groupId)]);
  if (!groupRows.length) return { skipped: true, reason: "group_missing" };
  const group = groupRows[0];
  await ensureWalletFinancialLockTx(tx, group.sender_address, now);
  const [activeRows] = await tx.query(
    `SELECT id FROM automatic_refund_payouts WHERE group_id=?
     AND status IN ('queued','signed','submitted','manual_review') LIMIT 1 FOR UPDATE`, [String(groupId)],
  );
  if (activeRows.length || ["manual_review", "reserved", "queued", "signed", "submitted"].includes(String(group.status))) {
    return { skipped: true, reason: "group_has_active_payout_or_review" };
  }
  const [eventRows] = await tx.query(
    `SELECT * FROM automatic_refund_group_events
     WHERE group_id=? AND status IN ('collecting','eligible') AND CAST(refund_eligible_at_ms AS UNSIGNED)<=?
       AND refunded_amount=0 AND reserved_amount=0
     ORDER BY finalized_at_ms,tx_hash,log_index,id FOR UPDATE`, [String(groupId), String(now)],
  );
  if (!eventRows.length) return { skipped: true, reason: "no_matured_events" };
  const gross = eventRows.reduce((sum, item) => sum.plus(bn(item.gross_amount, "gross amount")), ZERO);
  const fees = eventRows.reduce((sum, item) => sum.plus(bn(item.refund_fee_amount, "refund fee")), ZERO);
  const gas = bn(quote.gasEstimatedAmount, "estimated gas", true);
  const maximumGas = bn(quote.maximumGasAmount ?? MAXIMUM_REFUND_GAS_EQUIVALENT, "maximum gas", true);
  const net = BigNumber.maximum(ZERO, gross.minus(fees).minus(gas)).decimalPlaces(18, BigNumber.ROUND_DOWN);
  if (gas.gt(maximumGas)) return { skipped: true, reason: "gas_above_ceiling", netAmount: net.toFixed(18) };
  if (net.lt(ONE)) return { skipped: true, reason: "below_minimum", netAmount: net.toFixed(18) };
  const reference = createReference("ARFP");
  const [insertResult] = await tx.query(
    `INSERT INTO automatic_refund_payouts
     (group_id,reference,chain_id,token_contract,asset_code,payout_address,from_wallet_address,gross_reserved_amount,
      refund_fee_amount,gas_estimated_amount,net_amount,estimated_gas_fee_bnb,gas_limit,gas_price_wei,bnb_usd_price,status,created_at_ms,updated_at_ms)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'queued',?,?)`,
    [String(groupId), reference, String(group.chain_id), group.token_contract, group.asset_code,
      group.payout_address, address(quote.fromWalletAddress, "fromWalletAddress"), gross.toFixed(18), fees.toFixed(18), gas.toFixed(18), net.toFixed(18),
      String(quote.estimatedGasFeeBnb || "0"), String(quote.gasLimit || "0"), String(quote.gasPriceWei || "0"),
      String(quote.bnbUsdPrice || "0"), String(now), String(now)],
  );
  const payoutId = String(insertResult.insertId);
  for (const event of eventRows) {
    await tx.query(
      `UPDATE automatic_refund_group_events SET status='reserved',reserved_amount=gross_amount-refunded_amount,updated_at_ms=?
       WHERE id=? AND status IN ('collecting','eligible') AND reserved_amount=0 AND refunded_amount=0`,
      [String(now), String(event.id)],
    );
  }
  await tx.query(
    `UPDATE automatic_refund_groups SET status='queued',reserved_payout_id=?,gas_estimated_amount=?,
     net_estimated_amount=?,updated_at_ms=? WHERE id=?`,
    [payoutId, gas.toFixed(18), net.toFixed(18), String(now), String(groupId)],
  );
  return { queued: true, payoutId, reference, netAmount: net.toFixed(18), grossAmount: gross.toFixed(18), refundFeeAmount: fees.toFixed(18) };
}

async function restoreAutomaticRefundPayoutTx(tx, payoutId, reason, nowMs = Date.now()) {
  const now = String(timestamp(nowMs, "nowMs"));
  const [payoutRows] = await tx.query("SELECT * FROM automatic_refund_payouts WHERE id=? LIMIT 1 FOR UPDATE", [String(payoutId)]);
  if (!payoutRows.length) return { skipped: true, reason: "payout_missing" };
  const payout = payoutRows[0];
  if (["failed", "confirmed"].includes(String(payout.status))) return { skipped: true, reason: "already_final" };
  const [groupRows] = await tx.query("SELECT * FROM automatic_refund_groups WHERE id=? LIMIT 1 FOR UPDATE", [String(payout.group_id)]);
  if (!groupRows.length) throw new Error("The automatic refund group is missing while restoring a payout.");
  await ensureWalletFinancialLockTx(tx, groupRows[0].sender_address, Number(now));
  await tx.query(
    `UPDATE automatic_refund_group_events SET status='collecting',reserved_amount=0,updated_at_ms=?
     WHERE group_id=? AND status='reserved'`, [now, String(payout.group_id)],
  );
  await tx.query(
    `UPDATE automatic_refund_payouts SET status='failed',last_error=?,updated_at_ms=? WHERE id=? AND status NOT IN ('failed','confirmed')`,
    [String(reason || "Definitive payout failure").slice(0, 2000), now, String(payoutId)],
  );
  await tx.query(
    `UPDATE automatic_refund_groups SET status='collecting',reserved_payout_id=NULL,
     gas_estimated_amount=0,net_estimated_amount=0,last_error=?,updated_at_ms=? WHERE id=?`,
    [String(reason || "Definitive payout failure").slice(0, 2000), now, String(payout.group_id)],
  );
  return { restored: true, groupId: String(payout.group_id) };
}

async function confirmAutomaticRefundPayoutTx(tx, payoutId, receiptData, nowMs = Date.now()) {
  const now = timestamp(nowMs, "nowMs");
  const [payoutRows] = await tx.query("SELECT * FROM automatic_refund_payouts WHERE id=? LIMIT 1 FOR UPDATE", [String(payoutId)]);
  if (!payoutRows.length) throw new Error("The automatic refund payout does not exist.");
  const payout = payoutRows[0];
  if (String(payout.status) === "confirmed") return { confirmed: true, duplicate: true };
  const [groupRows] = await tx.query("SELECT * FROM automatic_refund_groups WHERE id=? LIMIT 1 FOR UPDATE", [String(payout.group_id)]);
  if (!groupRows.length) throw new Error("The automatic refund group is missing during payout confirmation.");
  const group = groupRows[0];
  await ensureWalletFinancialLockTx(tx, group.sender_address, now);
  const [events] = await tx.query(
    `SELECT * FROM automatic_refund_group_events WHERE group_id=? AND status='reserved'
     AND reserved_amount>0 ORDER BY finalized_at_ms,tx_hash,log_index,id FOR UPDATE`, [String(group.id)],
  );
  if (!events.length) throw new Error("The payout has no reserved source events; confirmation is not idempotently reconcilable.");
  const actualGas = bn(receiptData.actualGasFeeToken, "actual gas fee", true);
  const estimatedGas = bn(payout.gas_estimated_amount, "estimated gas fee", true);
  const payoutNet = bn(payout.net_amount, "payout net amount", false);
  const paidGross = events.reduce((sum, event) => sum.plus(bn(event.gross_amount)), ZERO);
  for (const event of events) {
    await tx.query(
      `UPDATE automatic_refund_group_events SET status='refunded',reserved_amount=0,
       refunded_amount=gross_amount,updated_at_ms=? WHERE id=? AND status='reserved'`,
      [String(now), String(event.id)],
    );

    // The immutable shared refund ledger is authoritative; keep the source
    // domain records synchronized so no legacy deposit worker can consume the
    // same source event again after a confirmed refund.
    const sourceTable = String(event.source_table || "");
    const sourceId = String(event.source_id || "");
    if (!/^\d{1,20}$/.test(sourceId)) throw new Error("Invalid source id while confirming an automatic refund.");
    if (sourceTable === "users_usdt_transfer_events") {
      const [sourceRows] = await tx.query(
        `SELECT id,batch_id FROM users_usdt_transfer_events WHERE id=? LIMIT 1 FOR UPDATE`, [sourceId],
      );
      if (sourceRows.length) {
        await tx.query(
          `UPDATE users_usdt_transfer_events SET status='refund_confirmed',reason_codes='["automatic_refund_confirmed"]' WHERE id=?`,
          [sourceId],
        );
        if (sourceRows[0].batch_id != null) {
          const [batchRows] = await tx.query(
            `SELECT id,reserved_refund_amount FROM users_usdt_deposit_batches WHERE id=? LIMIT 1 FOR UPDATE`,
            [String(sourceRows[0].batch_id)],
          );
          if (batchRows.length) {
            const slice = bn(event.gross_amount, "refunded BSC source amount", false);
            const reserved = bn(batchRows[0].reserved_refund_amount || "0", "reserved BSC refund amount", true);
            if (reserved.lt(slice)) throw new Error("The BSC deposit batch refund reservation is lower than the confirmed source slice.");
            const nextReserved = reserved.minus(slice);
            await tx.query(
              `UPDATE users_usdt_deposit_batches SET reserved_refund_amount=?,refunded_amount=refunded_amount+?,
               status=IF(?='0.000000000000000000','refunded','refund_queued'),updated_at_ms=? WHERE id=?`,
              [nextReserved.toFixed(18), slice.toFixed(18), nextReserved.toFixed(18), String(now), String(sourceRows[0].batch_id)],
            );
          }
        }
      }
    } else if (sourceTable === "bsc_unknown_incoming_transfers") {
      await tx.query(
        `UPDATE bsc_unknown_incoming_transfers SET status='refunded',decision_action='automatic_refund',
         refund_id=?,updated_at_ms=? WHERE id=? AND status IN ('automatic_refund_pending','refund_submitted','pending_admin')`,
        [String(payoutId), String(now), sourceId],
      );
    } else if (sourceTable === "xtu_deposit_transfer_events") {
      const [sourceRows] = await tx.query(
        `SELECT id,batch_id,event_identity FROM xtu_deposit_transfer_events WHERE id=? LIMIT 1 FOR UPDATE`, [sourceId],
      );
      if (sourceRows.length) {
        await tx.query(
          `UPDATE xtu_deposit_transfer_events SET status='refund_confirmed',reason_codes='["automatic_refund_confirmed"]' WHERE id=?`,
          [sourceId],
        );
        await tx.query(
          `UPDATE xtu_hot_wallet_lots SET pending_user_amount=0,protected_hot_wallet_amount=0,
           status='refunded',updated_at_ms=? WHERE event_identity=?`,
          [String(now), String(sourceRows[0].event_identity)],
        );
        if (sourceRows[0].batch_id != null) {
          const [pendingRows] = await tx.query(
            `SELECT COUNT(*) AS pending_count FROM xtu_deposit_transfer_events
             WHERE batch_id=? AND status NOT IN ('refund_confirmed','refunded','credited','forfeited_to_common_reserve')`,
            [String(sourceRows[0].batch_id)],
          );
          if (Number(pendingRows[0]?.pending_count || 0) === 0) {
            await tx.query(
              `UPDATE xtu_deposit_batches SET status='refunded',remaining_amount=0,updated_at_ms=? WHERE id=? AND status='refund_queued'`,
              [String(now), String(sourceRows[0].batch_id)],
            );
          }
        }
      }
    } else if (sourceTable === "xtu_unknown_incoming_transfers") {
      await tx.query(
        `UPDATE xtu_unknown_incoming_transfers SET status='refunded',refund_id=?,updated_at_ms=?
         WHERE id=? AND status IN ('automatic_refund_pending','refund_submitted','pending_admin')`,
        [String(payoutId), String(now), sourceId],
      );
      await tx.query(
        `UPDATE xtu_deposit_transfer_events SET status='refund_confirmed',reason_codes='["automatic_refund_confirmed"]'
         WHERE event_identity=? AND username IS NULL`, [String(event.event_identity)],
      );
    } else if (sourceTable !== "automatic_refund_payouts") {
      throw new Error(`Unsupported automatic refund source table ${sourceTable}.`);
    }
  }
  await tx.query(
    `UPDATE automatic_refund_payouts SET status='confirmed',actual_gas_fee_bnb=?,actual_gas_fee_token=?,
     tx_hash=COALESCE(tx_hash,?),block_number=?,receipt_json=?,confirmed_at_ms=?,updated_at_ms=? WHERE id=?`,
    [String(receiptData.actualGasFeeBnb || "0"), actualGas.toFixed(18), String(receiptData.txHash),
      String(receiptData.blockNumber), String(receiptData.receiptJson || "{}"), String(now), String(now), String(payoutId)],
  );
  const paidTotal = bn(group.net_paid_amount || "0").plus(payoutNet);
  const gasDifference = BigNumber.maximum(ZERO, estimatedGas.minus(actualGas)).decimalPlaces(18, BigNumber.ROUND_DOWN);
  await tx.query(
    `UPDATE automatic_refund_groups SET status=?,reserved_payout_id=NULL,
     gas_estimated_amount=0,net_estimated_amount=0,
     gas_actual_amount=gas_actual_amount+?,net_paid_amount=?,residual_amount=residual_amount+?,
     last_error=NULL,updated_at_ms=? WHERE id=?`,
    [gasDifference.isGreaterThan(0) ? "collecting" : "collecting", actualGas.toFixed(18), paidTotal.toFixed(18),
      gasDifference.toFixed(18), String(now), String(group.id)],
  );
  if (gasDifference.isGreaterThan(0)) {
    const syntheticIdentity = hashIdentity(`automatic-refund-gas-adjustment:${payoutId}:${gasDifference.toFixed(18)}`);
    await tx.query(
      `INSERT IGNORE INTO automatic_refund_group_events
       (group_id,source_table,source_id,source_kind,event_identity,chain_id,token_contract,asset_code,
        sender_address,payout_address,tx_hash,log_index,block_number,block_hash,gross_amount,refund_fee_amount,
        net_received_amount,reserved_amount,refunded_amount,residual_amount,finalized_at_ms,refund_eligible_at_ms,
        status,reason_code,created_at_ms,updated_at_ms)
       VALUES(?, 'automatic_refund_payouts', ?, 'gas_adjustment', ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 0, ?, 0, 0, ?, ?, ?, 'collecting', 'gas_estimate_correction', ?, ?)`,
      [String(group.id), String(payoutId), syntheticIdentity, String(group.chain_id), group.token_contract, group.asset_code,
        group.sender_address, group.payout_address, String(receiptData.txHash), String(receiptData.blockNumber),
        String(receiptData.blockHash), gasDifference.toFixed(18), gasDifference.toFixed(18), gasDifference.toFixed(18),
        String(now), String(now), String(now)],
    );
  }
  await recalculateGroupTotalsTx(tx, group.id, now);
  const [outstandingRows] = await tx.query(
    `SELECT COUNT(*) AS n FROM automatic_refund_group_events
     WHERE group_id=? AND status NOT IN ('refunded','resolved','cancelled')`, [String(group.id)],
  );
  if (Number(outstandingRows[0]?.n || 0) === 0) {
    await tx.query(
      `UPDATE automatic_refund_groups SET status='completed',reserved_payout_id=NULL,updated_at_ms=? WHERE id=?`,
      [String(now), String(group.id)],
    );
  }
  return { confirmed: true, payoutId: String(payoutId), groupId: String(group.id), paidGross: paidGross.toFixed(18), gasDifference: gasDifference.toFixed(18) };
}

async function markAutomaticRefundManualReviewTx(tx, payoutId, reason, nowMs = Date.now()) {
  const now = String(timestamp(nowMs, "nowMs"));
  const [rows] = await tx.query("SELECT * FROM automatic_refund_payouts WHERE id=? LIMIT 1 FOR UPDATE", [String(payoutId)]);
  if (!rows.length) return { skipped: true };
  const payout = rows[0];
  const [groups] = await tx.query("SELECT sender_address FROM automatic_refund_groups WHERE id=? LIMIT 1 FOR UPDATE", [String(payout.group_id)]);
  if (!groups.length) throw new Error("Refund group missing during manual review transition.");
  await ensureWalletFinancialLockTx(tx, groups[0].sender_address, Number(now));
  await tx.query(
    "UPDATE automatic_refund_payouts SET status='manual_review',last_error=?,updated_at_ms=? WHERE id=?",
    [String(reason || "Automatic refund requires manual reconciliation.").slice(0, 2000), now, String(payoutId)],
  );
  await tx.query(
    "UPDATE automatic_refund_group_events SET status='manual_review',updated_at_ms=? WHERE group_id=? AND status='reserved'",
    [now, String(payout.group_id)],
  );
  await tx.query(
    "UPDATE automatic_refund_groups SET status='manual_review',manual_review_reason=?,last_error=?,updated_at_ms=? WHERE id=?",
    [String(reason || "Automatic refund requires manual reconciliation.").slice(0, 2000), String(reason || "Manual review").slice(0, 2000), now, String(payout.group_id)],
  );
  return { manualReview: true, groupId: String(payout.group_id) };
}

module.exports = {
  ensureWalletFinancialLockTx,
  recalculateGroupTotalsTx,
  registerAutomaticRefundEventTx,
  getOutstandingRefundObligationsTx,
  reserveAutomaticRefundPayoutTx,
  restoreAutomaticRefundPayoutTx,
  confirmAutomaticRefundPayoutTx,
  markAutomaticRefundManualReviewTx,
  OUTSTANDING_EVENT_STATES,
};
