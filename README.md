# OneX Server

Node.js backend for the OneX platform. The current payment rail accepts **Binance-Peg BSC-USD (BEP-20)** on BNB Smart Chain mainnet (chain ID 56). This token is not USDt directly issued by Tether.

## Public unit: XTU (Extended Unit)

XTU is the public valuation of an initial asset in the OneX system. It is not a separately stored user-balance unit. All user, seller and internal reserve balances are stored in **initial assets**. The only live global price is `common.unit_price`, expressed as XTU per initial asset:

```text
common.unit_price = common.total_units_price / common.backed_units
user_balance_xtu = users_stock.balance * common.unit_price
initial_asset_amount = public_xtu_amount / common.unit_price
```

`common.total_units_price` is the only stock-value field stored in XTU. `common.backed_units` is stored in initial assets, remains consumable above the protected administrative quota, and is also the denominator used by the global price. The 10% administrative portion remains included in `backed_units` and therefore participates in XTU valuation; it is protected from ordinary user funding, not excluded from price calculation.

There is no individual live price for an account, sender, buyer or seller. All conversions use the global `common.unit_price` read and locked at the start of the relevant financial transaction. Historical prices and contractual price snapshots are stored only to preserve the valuation that applied when an operation or request was submitted.

## Internal accounting conventions

- `users_stock.balance`, `users_stock.run_balance` and `users_stock.pending_bonus` are initial assets.
- `common.backed_units`, `common.inactive_init_asset`, `common.sys_inactive_init_asset`, `common.sellers_res` and `common.total_run_balance` are initial assets.
- `common.total_units_price` is XTU. `common.unit_price` is always recomputed as `total_units_price / backed_units` on every common snapshot; `backed_units` must remain strictly positive.
- `activities.amount` and `activities.fees` are initial assets. `activities.unit_price` is the immutable global price used for the recorded transaction. Historical XTU values are `amount * activities.unit_price` and `fees * activities.unit_price`.
- Seller campaign and reserve-lot `unit_price` fields are immutable request-time valuation snapshots used to settle seller obligations at the price locked when the seller submitted `/app/join-system-sellers`. They are not live per-user prices.
- `users_usdt_disbursements.price_value` is the immutable price captured when the user submitted the sale-to-ONEX request. The payout is not revalued by a later common price.
- Seller payout and disbursement amounts persisted in BSC-USD payout columns are token liabilities, not XTU balances. BNB gas amounts remain in BNB; their captured BSC-USD equivalents remain separately identified.
- All financial calculations use `BigNumber`, never JavaScript floating-point arithmetic.

## Global price and reserve invariants

Every common snapshot derives the global price from the same formula:

```text
unit_price = total_units_price / backed_units
```

All common writes are serialized with the `common_state` lock and inserted through `insertCommonSnapshotTx()`, which recomputes `unit_price`. `getLatestCommonTx()` verifies that the stored value matches the ratio. A zero or negative `backed_units`, or a non-positive `total_units_price`, blocks the operation because the global price would be undefined or invalid.

The initial reserve is split by a fixed quota based on `STOCK_LIMIT`, not on the fluctuating public value:

```text
initial_admin_quota = STOCK_LIMIT * SYSTEM_ADMIN_RESERVE_RATIO
remaining_admin_quota = initial_admin_quota - common.sys_inactive_init_asset
ordinary_backed_available = common.backed_units - remaining_admin_quota
ordinary_reserve_available = common.inactive_init_asset + ordinary_backed_available
```

`SYSTEM_ADMIN_RESERVE_RATIO` defaults to 0.10. For a 10,000,000 initial-asset stock, 1,000,000 initial assets are reserved for administration and 9,000,000 are initially distributable. The administrative 1,000,000 remains part of `backed_units` and contributes to the global price. Only the remaining unspent portion is protected from ordinary recharge and disbursement use.

`common.sys_inactive_init_asset` is a cumulative ledger of initial assets spent administratively. It is not a spendable reserve and is not added to `inactive_init_asset`. An administrative expenditure of `amount` XTU uses the current global price:

```text
spent_initial_asset = amount / current_unit_price
total_units_price_after = total_units_price_before - amount
backed_units_after = backed_units_before - spent_initial_asset
sys_inactive_init_asset_after = sys_inactive_init_asset_before + spent_initial_asset
unit_price_after = total_units_price_after / backed_units_after
```

Because numerator and denominator decrease proportionally, the price remains unchanged, subject to storage precision. The operation cannot spend more than the remaining administrative quota and cannot leave `backed_units` at or below zero.

## Recharges and deposits

Each account has an individual BSC-USD deposit address. Finalized `Transfer` events are attributed by transaction hash and log index and grouped into 60-minute batches; a batch can contain any number of transfers.

- Automatic recharge minimum: 12 BSC-USD per batch.
- The 140 BSC-USD cap and seven-day cooldown apply only to the portion funded by ONEX reserves. Seller-funded amounts are exempt.
- The user's resulting public balance must not exceed 300 XTU, measured using the global price after the financial update.
- Net credit is `gross received - tfees - configured BSC gas recovery`. The recovered BSC cost covers only eligible OneX-paid outgoing operations; the user's own deposit gas is not charged again. The resulting net deposit amount is treated as its nominal XTU value for that recharge operation, then converted to initial assets using the global price captured before the operation.
- Funding priority is `common.sellers_res`, then `common.inactive_init_asset`, then `common.backed_units` above the remaining administrative quota.
- Seller-funded credit transfers initial assets from the seller reserve to the recipient. It does not issue a second copy of the seller-funded amount.
- The ONEX-funded portion converts its public XTU value to initial assets using the pre-operation global price. Common snapshots then recompute the global price from their resulting `total_units_price` and `backed_units`.
- A weekly-ineligible user receives no partial ONEX-funded credit. A pending batch is retried so it may be funded by sellers or after the weekly cooldown.
- The 70 BSC-USD amount is a deposit-wallet sweep threshold, not the recharge minimum. Older unswept finalized deposits are swept after 30 days.

`activities.amount` and `activities.fees` are stored in initial assets. `activities.unit_price` freezes the transaction price. The history endpoint returns both the internal initial-asset fields and their historical XTU equivalents.

## Priority seller reserve

- `POST /app/join-system-sellers` receives the selected `run_balance` in XTU and converts it to initial assets using the global price captured under the common-state lock at campaign submission.
- The user's `balance`, campaign `run_balance`, `pending_bonus`, common `sellers_res`, `total_run_balance`, and seller-lot quantities are stored in initial assets. Public eligibility thresholds (12 XTU, 50% lock and 10% pending bonus) are checked using the captured global price.
- 50% of the selected `run_balance` (excluding bonus) is assigned to `common.sellers_res`; the user's principal balance is not debited merely by joining. The seller reserve lot stores the campaign submission price as an immutable payout valuation snapshot.
- P2P availability during an active campaign is computed in initial assets as `balance - 0.5 * run_balance`. Incoming transfers remain allowed.
- Seller lots are consumed FIFO. Consumption reduces the seller's internal balance and lot amount in initial assets and creates a payout liability.
- Seller payout gross BSC-USD is calculated from each lot's consumed initial assets multiplied by the **price locked at that seller's campaign submission**. A later change to `common.unit_price` does not change that liability. Payout batches are capped at 300 BSC-USD gross per batch.
- Priority sellers pay no `tfees`; only the estimated BSC gas cost is deducted from their BSC-USD payout. Actual gas is recorded separately after finality.
- Seller status expires after seven days. Cancellation requests do not release unused reserve until the administrative unlock or normal expiry. Amounts already consumed remain payout liabilities.
- `common.total_run_balance` is the sum of active campaign run-balance references in initial assets.
- Bonus calculation, origin, accumulation, inactivity lifecycle and automatic credit remain deliberately unimplemented until separately specified. `pending_bonus` is stored in initial assets and only used for current eligibility checks.

## P2P transfers and transaction fees

`POST /app/near-transfer` accepts a public XTU amount for ordinary user-to-user transfers. The amount is converted once using the global `common.unit_price` locked during the transaction. The sender is debited the gross equivalent in initial assets; the recipient receives the net initial assets after the full `tfees` deduction. The recipient bears all `tfees`; no BSC gas fee applies to a P2P transfer.

The full fee basis is retained by OneX and added to `common.backed_units`; the equivalent public XTU fee amount is added to `common.total_units_price`. `common.total_tfees` accumulates the fee basis in initial assets and never decreases. This paired update preserves the pre-operation global price for the fee component. There is no separate CommonShare/AdminFees split or administrative fee-wallet transfer.

## Sale to ONEX (disbursement)

A system sale requires a public balance of at least 290 XTU, a registered payout address, no unresolved request and a successful-sale cooldown of 90 days. The complete internal balance is reserved in initial assets. The global price is captured when the user submits the request; `price_value`, gross/sold/fee initial-asset values and the BSC-USD payout are persisted in that request.

The BSC-USD payout remains fixed at that submission-time price even if `common.unit_price` changes while the request waits for treasury processing. The worker sends the already persisted amount and never reprices it at payment time. On canonical finality, common stock accounting applies the frozen payout and initial-asset basis while recalculating the current global price for subsequent operations. A confirmed sale starts the 90-day cooldown; a failed transaction restores the user's reserved initial-asset balance only after canonicality/finality checks.

Active or cancellation-pending seller campaigns prevent a system sale. Pending disbursement reservations count against the distributable initial-asset capacity and cannot consume the remaining protected administrative quota.

## Refunds, gas and cumulative fees

Refunds charge no `tfees`; only configured recovery of OneX-paid BSC gas is deducted, subject to the minimum net refund rule. Gas estimates and actual receipts remain separate. Actual BNB cost is `gasUsed * effectiveGasPrice`; each outgoing transaction is recorded in `bsc_fee_ledger` and should be counted once after canonical finality.

`common.total_tfees` is the cumulative retained transaction-fee basis in initial assets. `common.total_bnb_fee_actual` and `common.total_bnb_fee_estimated` are BNB, while their `_value` fields are captured BSC-USD equivalents. `BNB_USD_PRICE` must be a positive captured quote before outgoing BSC workers are enabled.

## Administrative stock endpoints

- `POST /admin/update-user-stock` credits one user through the same seller-first top-up allocator used by recharge processing. `amount` is public XTU/BSC-USD; the route converts it using the current global price. The normal automatic minimum is bypassed, but the user cap, ONEX-funded cooldown/cap, transaction fees, BSC recovery and administrative reserve floor remain enforced.
- `POST /admin/update-common-stock` is exclusively an administrative expenditure. `amount` is XTU; it is converted using the current global price and debited proportionally from `total_units_price` and `backed_units`. The initial-asset basis is added to `sys_inactive_init_asset`. It does not credit a user and is not a buyback or new issuance.

## Database and deployment

This is a target schema for a first deployment, not an automatic migration. Create a new empty MySQL database. Old `users_stock.init_asset` and `common.sellers_init_asset` fields are not part of the target schema. Do not attempt to reuse old balance snapshots without a separately designed, audited migration. All amounts must be converted from their historical unit according to each table's old schema and historical transaction price before any data migration.

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
2. By default, a new database starts with `common.total_units_price=10000000`, `common.backed_units=10000000` and the derived `common.unit_price=1`. `STOCK_LIMIT` and `INITIAL_BACKED_UNITS` can override the initial amounts; `INITIAL_BACKED_UNITS` defaults to `STOCK_LIMIT`, must cover the initial 10% administrative quota, and must correspond to assets actually available to the system. When the configured values differ, the initial price is derived as `total_units_price / backed_units`, not hard-coded to 1.
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

- `POST /app/user-last-stock`: returns the user's current XTU display balance calculated from the initial-asset balance and current global price, together with the initial-asset balance, P2P fee rate, deposit address and seller campaign fields.
- `POST /app/recharge`: returns deposit instructions and limits. It does not create a pre-payment order.
- `POST /app/recharge/status`: returns the user's latest or specified deposit batch status.
- `POST /app/set-payout-address`: lets the user declare the address that will receive a system-sale payout. OneX does not prove source-wallet ownership.
- `POST /app/near-transfer`: user-to-user P2P or a user sale to OneX. OneX cannot be the sender. P2P fees are paid entirely by the recipient.
- `POST /app/disbursement/status`: returns the status of a user's system-sale request.
- `POST /admin/unlock-disbursement`: requeues an expired, unsigned disbursement for the isolated worker after admin authentication and liquidity checks.
- `POST /admin/recharge/credit`: records an exceptional administrator-approved credit for a support-held recharge batch. It still enforces the 140 BSC-USD system-funded cap, weekly cooldown when ONEX reserves are needed, 300 XTU stock cap and reserve availability; seller funding remains first priority.
- `POST /admin/recharge/refund`: queues a refund of a support-held recharge batch. No `tfees` is charged; a configured estimate of OneX's BSC gas cost is deducted, and the net refund must be at least 10 BSC-USD.
- `POST /admin/update-user-stock`: applies an administrator-approved individual stock credit through the standard recharge allocator, preserving seller-first funding, system cooldown/cap, fees, cost recovery and the user balance ceiling. The automatic minimum is bypassed. Requires the configured administrator password and PIN.
- `POST /admin/update-common-stock`: records an administrative expenditure from the protected common allocation. `amount` is XTU / BSC-USD; the current unit price converts it to initial-asset basis, `total_units_price` decreases by `amount`, `unit_price` stays unchanged, and the spent basis moves from `backed_units` to `sys_inactive_init_asset`. Requires the configured administrator password and PIN.
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
