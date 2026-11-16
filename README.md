# OneX Server

Node.js backend for the OneX platform. The current payment rail accepts **Binance-Peg BSC-USD (BEP-20)** on BNB Smart Chain mainnet (chain ID 56). This token is not USDt directly issued by Tether.

## Public unit: XTU (Extended Unit)

XTU is the public unit of value and holding used by the OneX platform. It is the extended public expression of an initial asset under the platform's valuation rules. The initial asset remains the underlying economic and accounting basis; XTU is the unit presented to users and used for balances, transfers, accumulation and other platform operations. The relationship between an account's XTU balance and its initial-asset basis is governed by the platform's accounting and valuation rules, including `unit_price` and `users_stock.init_asset`. BSC-USD is the on-chain settlement asset and remains distinct from the XTU unit of account.

## Current core rules

- User stock is recorded in XTU; `users_stock.balance` is not converted by `unit_price`. `users_stock.init_asset` stores the corresponding initial-asset basis.
- P2P price is derived from the sender's current `balance / init_asset`. The sender pays only the gross requested amount; the recipient bears the full `tfees` deduction and receives the net amount. No BSC gas fee applies to P2P transfers.
- All `tfees` are retained in full by OneX, without a separate internal split. Their cumulative BSC-USD-equivalent amount is recorded in `common.total_tfees`, which never decreases.
- Each user has an individual BSC-USD deposit address. Finalized deposits are grouped into 60-minute batches; a batch can contain any number of transfers.
- The automatic recharge minimum is 12 BSC-USD per batch. The 140 BSC-USD limit and seven-day cooldown apply only to the portion funded by ONEX system reserves. Seller-funded amounts are exempt from that weekly restriction. The user's resulting balance must not exceed 300 XTU.
- Recharge credit is `gross received - tfees - configured BSC gas recovery`. The configured gas recovery is an estimate for OneX-paid outgoing deposit operations; the sender's own deposit gas is never charged again.
- Recharge funding priority is `common.sellers_res`, then `common.inactive_init_asset`, then `common.backed_units`. System-funded operations preserve the remaining administrative reserve floor, initially 10% of `STOCK_LIMIT` (`SYSTEM_ADMIN_RESERVE_RATIO`). This quota is reduced only by authorized administrative spending recorded in `common.sys_inactive_init_asset`. A weekly-ineligible user receives no partial system-funded credit. A pending batch is retried every five minutes so it can be funded later by sellers or after the weekly window.
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

- Common snapshots preserve all cumulative fields. `common.total_tfees` is the cumulative transaction-fee amount in BSC-USD-equivalent terms and never decreases. `common.sys_inactive_init_asset` is the cumulative initial-asset basis spent from the administrative reserve and never decreases. `common.total_bnb_fee_estimated` and `common.total_bnb_fee_actual` are BNB amounts; their `_value` counterparts are BSC-USD equivalents.
- Each outgoing BSC transaction is recorded in `bsc_fee_ledger` by transaction hash. Estimates are recorded when the transaction is prepared; actual fees are recorded only after the receipt is canonical and reaches finality. Actual BNB cost is `gasUsed * effectiveGasPrice`.
- `BNB_USD_PRICE` must be a positive, manually captured BNB/USD quote before enabling the sweeper or treasury payout workers. The captured value is stored with the fee ledger entry; it is not presented as a live price feed.

## System reserve: administrative 10% / distributable 90%

The initial system reserve is divided into two accounting portions. The administrative portion is initially `STOCK_LIMIT * SYSTEM_ADMIN_RESERVE_RATIO` (10% by default); the remaining 90% is initially available for user-facing distribution, subject to actual reserve balances. The administrative portion remains included in `common.total_units_price` and `common.backed_units`, but ordinary recharge funding and system disbursements must not consume its remaining protected initial-asset basis. This ratio is based on the initial `STOCK_LIMIT`, not a moving percentage of the current `total_units_price`.

`common.sys_inactive_init_asset` stores the cumulative initial-asset basis already spent from the administrative allocation. It is not a spendable reserve and is never added to `backed_units` or `inactive_init_asset`. The remaining protected initial-asset amount is:

```text
initial_admin_quota = STOCK_LIMIT * SYSTEM_ADMIN_RESERVE_RATIO
remaining_admin_quota = initial_admin_quota - common.sys_inactive_init_asset
```

A value above the configured initial quota is an accounting error and blocks the operation. At startup, OneX verifies that `common.backed_units` itself still covers the remaining protected quota; an inconsistent reserve state stops startup instead of silently weakening the floor. System-funded recharges and system-sale reservations calculate distributable initial assets as `max(0, backed_units + inactive_init_asset - remaining_admin_quota)`. Seller reserve funding remains separate and retains its existing priority.

For example, with `STOCK_LIMIT=10,000,000` and a 10% ratio, the initial administrative quota is 1,000,000 initial assets and the initial user-distributable capacity is 9,000,000. If an authorized administrative operation spends 100,000 initial assets, `sys_inactive_init_asset` becomes 100,000 and the remaining protected quota becomes 900,000; `backed_units` is reduced by the same 100,000. The distributable initial-asset capacity therefore remains 9,000,000 rather than increasing because administrative assets were spent.

Administrative common-stock operations use `POST /admin/update-common-stock`. The `amount` field is expressed in XTU / BSC-USD, not in initial-asset units. The operation converts it using the **current `common.unit_price` captured before the update**:

```text
spent_initial_asset = amount / current_unit_price
backed_units_after = backed_units_before - spent_initial_asset
sys_inactive_init_asset_after = sys_inactive_init_asset_before + spent_initial_asset
remaining_admin_quota_after = remaining_admin_quota_before - spent_initial_asset
```

The administrative buyback reduces the total XTU stock by the amount spent while preserving the current unit price: `total_units_price_after = total_units_price_before - amount` and `unit_price_after = current_unit_price`. This is not a new issuance or a repricing event. The operation is rejected if the requested XTU amount exceeds the value of the remaining administrative allocation at the current unit price, would reduce `total_units_price` to zero or below, or would create an invalid reserve. The endpoint keeps its existing administrative user-stock update branch as well as the common-stock branch; only the URL path is renamed.

The `tfees` retained by recharge, P2P and system-sale operations are recorded in full. Their full initial-asset basis is returned to `common.backed_units`, and their BSC-USD-equivalent value increases `common.total_tfees`. There is no separate reward wallet, transfer queue, transfer-history endpoint or treasury liquidity reservation. Seller payouts and refunds continue to charge no `tfees`; their BSC gas handling remains separate.

## P2P accounting

- `priceValue = sender.balance / sender.init_asset` is derived from the sender only.
- `amountUnits = requestedAmount / priceValue` and the net received basis are measured in initial-asset units.
- The sender's new `init_asset` is recalculated from the sender's new XTU balance divided by `priceValue`.
- The recipient retains its existing `init_asset`; its new basis is `old_init_asset + net_received_initial_asset`. Historical recipient balance is never repriced at the sender's transaction price.
- The recipient's XTU balance increases by the net initial-asset amount multiplied by the sender's `priceValue`.
- The complete fee basis is included in the basis-conservation check and retained in `common.backed_units`; its BSC-USD-equivalent value is added to `common.total_tfees`.

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
3. Set `SYSTEM_ADMIN_RESERVE_RATIO=0.10` and `RECHARGE_BSC_FEE_RECOVERY_USD` in `.env`. Remove any previous reserve-policy override and obsolete settings for the retired separate-fee transfer flow from existing environment files. Set `BNB_USD_PRICE` to a captured positive BNB/USD quote before enabling any outgoing BSC worker.
4. Copy `.env.disbursement.example` to `.env.disbursement`. Keep the treasury private key in this separate file, accessible only to the treasury worker account. Operational flags and `BNB_USD_PRICE` remain in the main `.env`; no separate destination or payout configuration for fee shares is required.
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
npm run disburse  # Separate treasury disbursement/refund and seller-payout worker
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
- `POST /admin/update-common-stock`: administrative update of a user's stock or the common stock. For the common-stock branch, `amount` is expressed in XTU / BSC-USD; it is converted to initial-asset basis using the current `common.unit_price` captured before the update, and the spent basis is recorded in `common.sys_inactive_init_asset`. Requires the configured administrator password and PIN.
- `POST /admin/send-temp-pswd`: issues a seven-digit temporary password by email; valid for 10 minutes and usable only to sign in and change the permanent password.
- `POST /app/join-system-sellers`: requests activation of a priority seller campaign.
- `POST /app/cancel-system-sellers`: requests cancellation; the unused seller reserve remains locked pending admin review.
- `POST /admin/unlock-system-seller`: releases the unused portion of a seller lot after administrative authorization.

## Tests and production readiness

`npm start` also launches the seller lifecycle worker in-process; its MySQL advisory lock prevents concurrent processing by duplicate instances. `npm run check` validates JavaScript syntax. `npm test` runs the business-rule unit tests. These checks do not replace MySQL integration tests, BNB Smart Chain testnet exercises, SMTP tests, or a full reconciliation rehearsal before production.

## API security and request-abuse controls

The HTTP process applies request limits before parsing the request body. The default global IP limit is 180 requests per 60 seconds. Stricter per-route IP windows also cover APK/privacy downloads, version checks, sign-in, registration, stock/recharge reads, payout-address changes, seller actions, transaction history, P2P transfers, disbursement status, account deletion, credential updates, recovery, contact messages and administrative actions. Matching is case-insensitive and ignores trailing slashes to avoid trivial route-limit bypasses. `TRUST_PROXY_HOPS` must match the actual reverse-proxy topology; it defaults to `0` so untrusted `X-Forwarded-For` headers are not accepted as client identity. If TLS terminates at a trusted reverse proxy, configure the appropriate hop count. `FORCE_HTTPS=true` additionally requires `PUBLIC_HTTPS_ORIGIN` and redirects requests to that canonical HTTPS origin.

Normal JSON and URL-encoded request bodies are limited to 256kb. Registration has a separate `SIGNUP_BODY_LIMIT` (10mb by default, hard-capped at 10mb) because identity images are sent with the signup request; each provided base64 image is validated and limited to 3mb after decoding. Signup fields are checked before Argon2 work, and username collision retries are capped at ten attempts.

### Per-account 24-hour security quotas

The following limits use rolling 24-hour windows, persisted in MySQL and serialized with account-specific row locks:

- Password change: up to three failed attempts and one successful change. The successful change remains available even after three failed attempts; a fourth failed attempt returns `{ "auth": "limit reached" }`.
- Seed change: the same three-failed / one-successful rule.
- Account recovery: two requests total. A request is counted before seed verification, so incorrect seeds also consume one of the two requests. A third request returns `{ "auth": "limit reached" }`.

The `account_security_events` table stores the quota events. Events older than eight days are removed by the regular cleanup job; the decision itself only counts the preceding 24 hours. The account action lock rows serialize concurrent requests so simultaneous submissions cannot exceed the quotas.

### Other per-account limits

Authenticated request limits also protect contact messages, stock reads, recharge information/status, payout-address changes, seller activation/cancellation, transaction history, P2P transfers, disbursement status and account deletion. These are additional abuse controls and do not alter the financial calculations or the business eligibility checks. Their counters are stored in `account_api_rate_limits` and are removed after their fixed-window retention period.

### Database and resource protections

`multipleStatements` is disabled in the MySQL pool. User-provided SQL values remain parameterized; SQL identifiers used in generated statements come only from internal allowlists. The new security-limit queries use MySQL prepared execution. The pool defaults to 20 connections and a queue of 100 waiting requests, configurable through `DB_CONNECTION_LIMIT` and `DB_QUEUE_LIMIT`.

Argon2id concurrency remains bounded. Its waiting queue defaults to 20 jobs and expires a queued request after 15 seconds. Queue saturation returns a temporary-unavailability response instead of allowing an unbounded backlog.

Email delivery is bounded by an in-process queue: at most 30 messages initiated per hour, 50 waiting messages, two concurrent SMTP sends and two attempts per message by default. Per-account and per-IP endpoint limits are applied before sending. This mail queue is intentionally in-memory; pending messages are not durable across a process restart.

### Transaction history API

`POST /app/transactions-history` now enforces a maximum of 30 rolling days (the stored UTC activity timestamp is accurate to one second; the cutoff is rounded upward so no older second is included), regardless of a larger requested `days` value. It returns at most 100 rows per request (50 by default). The existing `trans` response property is preserved. When another page may exist, `next_before_id` contains the last returned activity ID; send it as `before_id` on the next request. The cursor prevents deep `OFFSET` scans and preserves descending ID order.

The IP limiter is process-local. For a deployment with multiple Node.js instances, enforce the same or stricter IP limits at the shared reverse proxy/API gateway. Per-account quotas and the additional per-account request counters are MySQL-backed and therefore shared across instances.
