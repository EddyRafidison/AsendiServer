# OneX Server

Node.js backend for the OneX platform. The current payment rail accepts **Binance-Peg BSC-USD (BEP-20)** on BNB Smart Chain mainnet (chain ID 56). This token is not USDt directly issued by Tether.

## Public unit: XTU (Extended Unit)

XTU is the public unit of value and holding used by the OneX platform. It is the extended public expression of an initial asset under the platform's valuation rules. The initial asset remains the underlying economic and accounting basis; XTU is the unit presented to users and used for balances, transfers, accumulation and other platform operations. The relationship between an account's XTU balance and its initial-asset basis is governed by the platform's accounting and valuation rules, including `unit_price` and `users_stock.init_asset`. BSC-USD is the on-chain settlement asset and remains distinct from the XTU unit of account.

## Current core rules

- User stock is recorded in XTU; `users_stock.balance` is not converted by `unit_price`. `users_stock.init_asset` stores the corresponding initial-asset basis.
- P2P price is derived from the sender's current `balance / init_asset`. The sender pays only the gross requested amount; the recipient bears the full `tfees` deduction and receives the net amount. No BSC gas fee applies to P2P transfers.
- Transaction fees are split equally: 50% `CommonShare` and 50% `AdminFees`. Both reward totals are denominated in BSC-USD. `common.total_adminFees` is cumulative and never decreases; `common.remaining_adminFees` is the untransferred administrative-reward balance.
- Each user has an individual BSC-USD deposit address. Finalized deposits are grouped into 60-minute batches; a batch can contain any number of transfers.
- The automatic recharge minimum is 12 BSC-USD per batch. The 140 BSC-USD limit and seven-day cooldown apply only to the portion funded by ONEX system reserves. Seller-funded amounts are exempt from that weekly restriction. The user's resulting balance must not exceed 300 XTU.
- Recharge credit is `gross received - tfees - configured BSC gas recovery`. The configured gas recovery is an estimate for OneX-paid outgoing deposit operations; the sender's own deposit gas is never charged again.
- Recharge funding priority is `common.sellers_res`, then `common.inactive_init_asset`, then `common.backed_units`. The last two are limited by the non-distributable 20% system reserve floor (`STOCK_LIMIT * SYSTEM_RESERVE_RATIO`). A weekly-ineligible user receives no partial system-funded credit. A pending batch is retried every five minutes so it can be funded later by sellers or after the weekly window.
- Deposit addresses are consolidated individually at 70 BSC-USD or when the oldest unswept finalized deposit reaches 30 days. The 70 BSC-USD value is a sweep threshold, not the recharge minimum.
- A system sale to ONEX requires at least 290 XTU, sells the full balance and deducts `FEES` from the gross balance. The net BSC-USD is reserved and paid by the isolated treasury worker. A successful sale starts a 90-day cooldown. A user with an active or cancellation-pending seller campaign cannot liquidate the account through this path.
- System disbursements and refunds respect a 60-minute reservation, canonical-chain checks and the configured finality depth (15 confirmations by default). A refund has no `tfees`; only the estimated BSC gas recovery is deducted, and the net refund must be at least 10 BSC-USD.
- All new database timestamps and worker scheduling use UTC.

## Priority seller reserve

- A seller campaign starts through `POST /app/join-system-sellers`. The user must have a balance greater than 12 XTU, choose `run_balance` of at least 50% of the current balance and at least 12 XTU, and have `pending_bonus >= 10% * run_balance`.
- `run_balance` is a fixed campaign reference. The system reserves 50% of it in `common.sellers_res` and moves the corresponding initial-asset basis to `common.sellers_init_asset`; the user's displayed balance is not reduced when joining.
- While `seller_status` is active or cancellation-pending, the sender cannot transfer more than `balance - 0.5 * run_balance` through P2P. Incoming transfers remain allowed.
- Seller reserve lots are tracked individually and consumed FIFO. When a lot is consumed to fund a recharge, its seller's XTU balance and initial-asset basis are reduced, and the amount becomes a seller payout liability.
- Seller payouts are grouped when the outstanding amount reaches 300 XTU; each treasury batch is capped at 300 XTU. The treasury pays each seller's registered payout address in BSC-USD. The seller bears only the estimated BSC gas recovery; no `tfees` is charged on seller payouts.
- Seller status expires after seven days. A user may request cancellation through `POST /app/cancel-system-sellers`; the unused reserve remains locked until an administrator uses `POST /admin/unlock-system-seller`. Amounts already sold remain in the payout queue.
- `pending_bonus` is stored and checked for eligibility, but bonus accrual, origin, calculation, the 24-hour bonus inactivity lifecycle, automatic credit and campaign-bonus generation are intentionally not implemented until those rules are specified. The code does not invent a bonus formula.

## Reserve and BSC fee accounting

- Common snapshots preserve all cumulative fields. `common.total_bnb_fee_estimated` and `common.total_bnb_fee_actual` are BNB amounts; their `_value` counterparts are BSC-USD equivalents. `common.total_common_share`, `common.total_adminFees` and `common.remaining_adminFees` are BSC-USD amounts. `total_adminFees` is cumulative; `remaining_adminFees` can decrease only after a confirmed administrative payout.
- Each outgoing BSC transaction is recorded in `bsc_fee_ledger` by transaction hash. Estimates are recorded when the transaction is prepared; actual fees are recorded only after the receipt is canonical and reaches finality. Actual BNB cost is `gasUsed * effectiveGasPrice`.
- `BNB_USD_PRICE` must be a positive, manually captured BNB/USD quote before enabling the sweeper or treasury payout workers. The captured value is stored with the fee ledger entry; it is not presented as a live price feed.

## Administrative rewards (`AdminFees`)

- `AdminFees` are tracked in BSC-USD, independently from initial-asset reserve accounting.
- `common.total_adminFees` is the lifetime cumulative amount of administrative rewards generated. It must never decrease.
- `common.remaining_adminFees` is the BSC-USD amount still held in the main treasury and available for the administrative wallet. It increases with each new `AdminFees` accrual and decreases only after the corresponding BSC-USD transfer has reached the configured confirmation depth and the canonical Transfer event has been verified.
- The initial-asset basis corresponding to the administrative reward is returned to the system reserves. For recharge and P2P fees, that basis is added to `inactive_init_asset`; for system disbursement, the fee basis is allocated 50/50 between `backed_units` (CommonShare) and `inactive_init_asset` (AdminFees). The BSC-USD reward transfer does not consume those initial-asset reserves.
- When `remaining_adminFees >= ADMIN_FEES_THRESHOLD_USD` (100 by default), OneX queues a transfer of exactly `remaining_adminFees - ADMIN_FEES_RETAINED_BALANCE_USD` (10 by default) from the main treasury to `ADMIN_FEES_PAYOUT_ADDRESS`. It therefore leaves the configured 10 BSC-USD residual when no new reward arrives while the transfer is pending. If new rewards arrive before confirmation, the post-transfer balance includes those new rewards and may trigger another transfer.
- No payout is queued when the threshold is invalid (zero, negative or non-finite), the retained balance is invalid, the destination address is invalid, or `ADMIN_FEES_TRANSFERS_ENABLED` is not `true`.
- The transfer is performed by the isolated treasury worker (`npm run disburse`), using the same BSC treasury key held in `.env.disbursement`. The BNB gas cost is recorded separately in `bsc_fee_ledger`; it is not deducted from the BSC-USD amount sent to the administrative wallet.
- `POST /admin/admin-fees-transfers` returns the authenticated, paginated history and the current cumulative and remaining balances. Supported status filters are `queued`, `signed`, `submitted`, `confirmed`, `failed` and `manual_review`.

## P2P accounting

- `priceValue = sender.balance / sender.init_asset` is derived from the sender only.
- `amountUnits = requestedAmount / priceValue` and the net received basis are measured in initial-asset units.
- The sender's new `init_asset` is recalculated from the sender's new XTU balance divided by `priceValue`.
- The recipient retains its existing `init_asset`; its new basis is `old_init_asset + net_received_initial_asset`. Historical recipient balance is never repriced at the sender's transaction price.
- The recipient's XTU balance increases by the net initial-asset amount multiplied by the sender's `priceValue`.
- The fee is included in the basis conservation check and split 50/50 between CommonShare and AdminFees.

## Authentication and account recovery

- `auths.consec_failed_auth` starts at `0` and is capped at `3`. Each incorrect password submitted to `/app/signin` increments it. Once it reaches `3`, ordinary-password sign-in is blocked. A successful ordinary sign-in does not reset this value.
- Account recovery (`POST /app/recover-account`) verifies the user's recovery seed and emails a cryptographically generated, seven-digit numeric temporary password. The code expires after 10 minutes.
- An administrator can independently issue the same temporary credential through `POST /admin/send-temp-pswd`, using the configured admin password and PIN. It is emailed to the account's registered email address.
- A valid temporary password may be used to sign in after a lock. Immediately after a successful sign-in with the temporary password, `consec_failed_auth` is reset to `0`; however, `password_temp_expires_at_ms` remains set, so every other password-protected activity returns `{ "auth": "not allowed" }` until the user changes the temporary password to a different permanent password.
- The password-change endpoint is the only ordinary account activity allowed while the temporary-password marker exists. It requires an unexpired temporary password and a different new password. On success it clears `password_temp_expires_at_ms` and keeps `consec_failed_auth=0` in the same SQL transaction.
- If the temporary password expires before being changed, the account remains activity-locked. The user must request a new temporary password through seed recovery or the administrator route.
- If SMTP delivery fails, the previous password hash and temporary-password expiry are restored when the temporary credential is still the current credential. The failed-authentication counter is not reset by issuing a code.

## Optional Telegram notifications

- Telegram is optional. Users can sign in and use financial features without linking a bot account. Transactional notifications are sent through Telegram only when both `tg_userId` and `tg_chat_id` are linked.
- `/app/signin` returns `tg_botLink`: the plain bot link for an already linked user, or a deep link containing a one-time 10-minute token for an unlinked user. The Android app can open this link from its Telegram button.
- Run exactly one Telegram long-polling worker with `npm run telegram`. It handles `/start` association, private-chat block events and the temporary outbox. Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_BOT_USERNAME` in `.env`.
- Telegram messages are English-only. SMTP remains enabled for the new username after signup, temporary recovery passwords, and `/app/contact-onex`. The existing identity-document email to the account-verification administrator remains a separate signup-review workflow, not a transaction notification.
- The `notifs` table and the legacy feed endpoints are not part of the current schema. Financial tables remain the source of truth; `telegram_outbox` is only a delivery queue and not a notification history.


Telegram delivery note: the outbox provides at-least-once delivery. If Telegram accepts a message but the worker stops before recording `sent`, the message can be delivered again after restart. Transaction references in messages make such a duplicate recognizable; Telegram `sendMessage` does not provide a general exactly-once idempotency key.

## Database

This version defines the **final schema for a first deployment**. It intentionally does not migrate or backfill legacy tables. Create a new, empty MySQL database before starting this version. `initDbIfEmpty()` creates the required tables and verifies required columns; it does not alter an existing legacy schema.

Do not run this code against a database containing older OneX table definitions unless you have independently reviewed and prepared that database.

## Configuration

1. Copy `.env.example` to `.env` and configure MySQL, SMTP, admin credentials, BSC RPC endpoints, treasury address, token contract, public deposit HD key, and the initial reserve.
2. By default, a new database starts with `common.total_units_price=10000000`, `common.unit_price=1` and `common.backed_units=10000000`. `STOCK_LIMIT` and `INITIAL_BACKED_UNITS` can override these defaults; `INITIAL_BACKED_UNITS` defaults to `STOCK_LIMIT` and must not exceed it. The declared backed reserve must correspond to assets actually available to the system.
3. Set `COMMON_SHARE_RATIO=0.50`, `SYSTEM_RESERVE_RATIO=0.20`, and `RECHARGE_BSC_FEE_RECOVERY_USD` in `.env`. Set `BNB_USD_PRICE` to a captured positive BNB/USD quote before enabling any outgoing BSC worker.
4. Copy `.env.disbursement.example` to `.env.disbursement`. Keep the treasury private key in this separate file, accessible only to the treasury worker account. Policy flags, the dedicated admin-fees destination and `BNB_USD_PRICE` remain in the main `.env`. Set `ADMIN_FEES_TRANSFERS_ENABLED=true`, configure a valid `ADMIN_FEES_PAYOUT_ADDRESS`, a positive `ADMIN_FEES_THRESHOLD_USD` and a non-negative retained balance below the threshold to enable automatic administrative payouts.
5. Copy `.env.sweeper.example` to `.env.sweeper`. Set the same captured `BNB_USD_PRICE` there because this worker loads its dedicated environment with override enabled. Keep the deposit HD private extended key and the separate gas-funder private key in this file, accessible only to the sweeper account.
6. Never commit or distribute real `.env` files, extended private keys, seed phrases, or wallet private keys.
7. Configure `BSC_DEPOSIT_XPUB` and its corresponding `BSC_DEPOSIT_XPRV` for the same non-hardened derivation branch. Keep the XPRV out of the HTTP server process.

The treasury must hold sufficient BSC-USD for payouts/refunds and BNB for transaction gas. The gas-funding wallet must hold BNB to fund individual deposit addresses before consolidation.

## Install and run

Requires Node.js 18 or later.

```bash
npm install
npm run check
npm test
```

Start each process under a service supervisor (PM2, systemd, or equivalent):

```bash
npm start        # HTTP API and BEP-20 deposit scanner
npm run telegram  # Telegram linking, block events and transactional outbox
npm run sweep     # Separate deposit-address consolidation worker
npm run disburse  # Separate treasury disbursement/refund, seller payout and admin-fees worker
```

Set `USDT_SELLER_PAYOUTS_ENABLED=true` only when seller treasury payouts are ready. Enable each blockchain process only after its environment file, RPC, wallet addresses, and balances have been verified. Do not enable mainnet sends while testing business logic.

## Request encoding

- Express performs standard `application/x-www-form-urlencoded` decoding. The server does not replace spaces with `+` and does not rewrite submitted passwords, seeds, names or free-form values.
- Android clients should use a standard form encoder. In URL-encoded forms, a literal plus sign must be encoded as `%2B`; a space is normally encoded as `+` or `%20` by the encoder. Do not manually replace spaces or plus signs after encoding.
- JSON requests preserve spaces and plus signs as literal characters and are preferred for values where form-encoding ambiguity is undesirable.

## Important endpoints

- `POST /app/user-last-stock`: returns XTU balance, P2P fee rate, deposit address and seller campaign fields.
- `POST /app/recharge`: returns deposit instructions and limits. It does not create a pre-payment order.
- `POST /app/recharge/status`: returns the user's latest or specified deposit batch status.
- `POST /app/set-payout-address`: lets the user declare the address that will receive a system-sale payout. OneX does not prove source-wallet ownership.
- `POST /app/near-transfer`: user-to-user P2P or a user sale to OneX. OneX cannot be the sender. P2P fees are paid entirely by the recipient.
- `POST /app/disbursement/status`: returns the status of a user's system-sale request.
- `POST /admin/unlock-disbursement`: requeues an expired, unsigned disbursement for the isolated worker after admin authentication and liquidity checks.
- `POST /admin/recharge/credit`: records an exceptional administrator-approved credit for a support-held recharge batch. It still enforces the 140 BSC-USD system-funded cap, weekly cooldown when ONEX reserves are needed, 300 XTU stock cap and reserve availability; seller funding remains first priority.
- `POST /admin/recharge/refund`: queues a refund of a support-held recharge batch. No `tfees` is charged; a configured estimate of OneX's BSC gas cost is deducted, and the net refund must be at least 10 BSC-USD.
- `POST /admin/admin-fees-transfers`: returns the paginated administrative-reward transfer history and the current `total_adminFees` / `remaining_adminFees` balances. Requires the configured administrator password and PIN.
- `POST /admin/send-temp-pswd`: issues a seven-digit temporary password by email; valid for 10 minutes and usable only to sign in and change the permanent password.
- `POST /app/join-system-sellers`: requests activation of a priority seller campaign.
- `POST /app/cancel-system-sellers`: requests cancellation; the unused seller reserve remains locked pending admin review.
- `POST /admin/unlock-system-seller`: releases the unused portion of a seller lot after administrative authorization.

## Tests and production readiness

`npm start` also launches the seller lifecycle worker in-process; its MySQL advisory lock prevents concurrent processing by duplicate instances. `npm run check` validates JavaScript syntax. `npm test` runs the business-rule unit tests. These checks do not replace MySQL integration tests, BNB Smart Chain testnet exercises, SMTP tests, or a full reconciliation rehearsal before production.
