# OneXServer — MAJ6 implementation status

Date: 28 November 2026  
Implementation milestone: Stage 1 — accounting and schema foundations  
Base archive: `OneXServer-Revision4-MAJ6-Integration-partielle-2026-11-28.zip`  
Normative specifications:
- `ONEXSERVER_REVISION5_MAJ5_SPECIFICATION_2026-11-27.txt`
- `ONEXSERVER_REVISION5_MAJ6_UPDATE3_2026-11-28.txt`

## Current status

**Stage 1 foundation work is present. The complete MAJ5/MAJ6 migration is not complete, and this archive is not production-ready.**

## Stage 1 work included

1. **Administrative reserve accounting**
   - `common.admin_expens` represents outstanding administrative expenses not yet recovered and is validated against `STOCK_LIMIT × SYSTEM_ADMIN_RESERVE_RATIO`.
   - `common.backed_units` must remain at or above the unspent administrative reserve floor: `Q - common.admin_expens`.
   - `common.total_gifts` is validated as a non-negative monotonic counter.
   - Existing `/admin/res/minus`, `/admin/res/plus` and `/admin/res/give` routes, their external-reference idempotency, transactional common snapshots, activity/gift records and separate rate limits are carried forward.
   - The obsolete `/admin/update-common-stock` route and `calculateAdminCommonStockUpdate()` are absent.

2. **Automatic-refund schema/policy correction**
   - Removed `next_review_at_ms` and `review_due_at_ms` from the new refund-group schema and its schema assertions.
   - Removed `SMALL_REFUND_REVIEW_DELAY_MS`, `reviewDue` output and age-based review behavior from `automatic-refund-policy.js`.
   - Retained the individual 30-minute per-event eligibility delay and the fixed one-token net minimum.
   - This is only a schema/policy correction; the scanners, grouping database operations and payout worker are not connected yet.

3. **Address-level locking foundations**
   - Added `bsc_wallet_financial_locks` with normalized wallet address as primary key and timestamps.
   - Added `registered_at_block` and its index to `bsc_wallet_address_registry`.
   - The new block field defaults to `0` as an explicit not-yet-initialized sentinel. Stage 1 does not yet implement signup scanner catch-up or shared lock acquisition in signup/scanners/workers.

4. **Autonomous XTU-free register foundations**
   - Added tables for XTU-free balances, deposit attempts and source events, append-only balance ledger, reservations and allocations, user externalization balances/ledger, custody lots, and the receive-fee ledger.
   - Added required-column and required-index assertions for these tables.
   - Added `xtu-free-accounting.js` helpers for qualification (1 net XTU, up to five unique finalized events), event-frozen receive-fee calculations, global-period zero receive fees, no age-based expiry, balance transitions and FIFO custody-lot selection (minimum 100 XTU).
   - Added `xtu-free-ledger.js` with a transaction-scoped append-only ledger helper, row locking, idempotency checks, source-event uniqueness and balance reconciliation.
   - These helpers and tables are not yet connected to scanners, custody consolidation, XTU withdrawal, or disbursement workers.

5. **Documentation**
   - Added the exact MAJ5 and MAJ6 UPDATE3 specification texts to `docs/`.
   - Updated the README milestone description and recorded the remaining integration boundaries.

## Explicitly not included in Stage 1

- End-to-end automatic refunds for categories A, B, C and D.
- Scanner integration for BSC-USD or XTU, automatic handling of deactivated accounts, category-D conversion at the BSC-USD deposit-attempt deadline, grouped payout signing/transmission/confirmation, retry and restoration logic.
- `/app/signup` refund-pending response, address-level shared lock usage, scanner catch-up to a finalized `registered_at_block`, and concurrency/race-condition protections.
- MAJ5 XTU contract migration (removing the legacy 0.1% contract commission) and complete XTU scanner/worker migration.
- Migration of individual/global disbursements to XTU-free balances, including complete snapshot, post-snapshot complementary register, reservation, allocation and settlement paths.
- MySQL integration, EVM integration, controlled-receipt/reorg tests, or live blockchain operations.

## Validation actually performed

- `node scripts/syntax-check.js`: **passed for 105 JavaScript files**.
- `node --test tests/admin-stock-routes.test.js tests/stage1-schema.test.js`: **7 tests passed, 0 failed**. These are structural/source-level tests and do not execute financial database paths.
- BigNumber-dependent tests could not be loaded because `bignumber.js` is not installed in the provided environment (`MODULE_NOT_FOUND`). No arithmetic test result is claimed.
- No MySQL server/schema initialization was run.
- No EVM/Ganache/contract test was run.
- No blockchain transaction, payout or deployment was performed.

## Deployment and database note

The project specification says the service is not deployed and calls for a clean schema, not a migration. Recreate the development database from the current `db.js` schema when the MySQL environment is available. Do not enable deposit, refund, consolidation, or disbursement workers on the basis of this Stage 1 archive. Complete and validate the remaining stages first.
