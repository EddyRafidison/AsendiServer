ONEXSERVER — MAJ6 CODE INTEGRATION STATUS
Date: 28 November 2026
Base: OneXServer Revision 4 ZIP
Specification: Revision 5 MAJ6 consolidated (28 November 2026)

STATUS: PARTIAL INTEGRATION — NOT PRODUCTION READY

Implemented in this archive
============================
1. New common columns admin_expens and total_gifts are included in the fresh schema, common snapshots and schema assertions.
2. common.admin_expens is validated as non-negative and capped at STOCK_LIMIT × SYSTEM_ADMIN_RESERVE_RATIO. It represents outstanding, unrecovered administrative expense, not lifetime cumulative expense.
3. Protected administrative backing is calculated from (STOCK_LIMIT × SYSTEM_ADMIN_RESERVE_RATIO) - common.admin_expens. Active ordinary deposit/reserve-availability call sites were changed to use this amount instead of sys_inactive_init_asset. The latter remains in the schema as a legacy field.
4. POST /admin/res/minus, POST /admin/res/plus and POST /admin/res/give were added. They require existing admin password/PIN authentication, a unique external_reference, common_state row lock, transaction scope, common snapshot and independent rate limits.
5. Expenditure and recovery are recorded as activities type 6 (ONEX -> XADMIN) and type 7 (XADMIN -> ONEX), fees=0 and the captured global unit price. Gifts are recorded only in gifts; no synthetic activity is created.
6. admin_external_settlements prevents the same external reference from being reused across any of the three routes. Exact retries return the original operation; mismatched retries are rejected.
7. The old /admin/update-common-stock route and calculateAdminCommonStockUpdate helper were removed.
8. The BSC refund minimum and the XTU unknown-refund policy default are fixed at 1 net token unit; the 0.8 threshold is no longer used in these refund-policy decisions. The separate seller payout minimum policy is not changed by this rule.
9. automatic_refund_groups, automatic_refund_group_events and automatic_refund_payouts schema tables were added. automatic-refund-policy.js implements compatibility grouping, per-event 1% retention calculation, each event's 30-minute delay, one gas deduction per grouped payout, the 1-unit minimum, the 0.4 gas ceiling, and review_due calculation.

Outstanding work before MAJ6 completion
=======================================
1. The new group/event/payout ledger and policy calculator are not yet wired into the live BSC-USD and XTU deposit scanners or payout workers. The current R4 worker paths do not populate or process these tables.
2. Deactivated-account BSC-USD deposits and XTU deposits still use the R4 pending_support behavior instead of automatically moving every uncredited event and future incoming transfer into the grouped refund ledger.
3. The BSC refund worker still rejects known-account deposit batches and keeps the R4 unknown-transfer request/approval workflow. This does not satisfy MAJ6 automatic execution for categories A/B/C.
4. The XTU unknown-refund worker retains R4 request/approval and receipt-validation logic for TransferWithFee; the XTU token contract still includes the old 0.1% commission design. MAJ5's fee-free XTU contract and the off-chain 1% refund retention are therefore not fully ported to the XTU execution path.
5. The complete MAJ5 architecture remains outside this partial port. In particular, the autonomous XTU-free ledger and the MAJ5 individual/global disbursement system are not fully migrated from the R4 code.
6. Runtime, MySQL, EVM and end-to-end tests have not been executed. No blockchain action or deployment has been performed.

Validation performed
====================
- node scripts/syntax-check.js: passed for the JavaScript files in the working tree.
- Full npm test suite: not executed because node_modules are absent in the provided environment.
- No MySQL schema initialization or blockchain transaction test is claimed.

Database / deployment note
===========================
The project specifications state that OneXServer is not deployed and require the definitive schema to be integrated directly in db.js without migration scripts. This archive follows that approach. Recreate the development database from the current db.js schema before testing.

Do not enable automated deposit/refund/disbursement workers in a live environment until all outstanding work above has been implemented and verified.
