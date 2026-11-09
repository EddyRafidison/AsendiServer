# OneX Server

Node.js backend for the OneX platform. The current payment rail accepts **Binance-Peg BSC-USD (BEP-20)** on BNB Smart Chain mainnet (chain ID 56). This token is not USDt directly issued by Tether.

## Current core rules

- User stock is recorded in One-Val; `users_stock.balance` is not converted by `unit_price`.
- `users_stock.init_asset` records the user's initial-asset basis.
- P2P unit price is derived from the sender's current `balance / init_asset`.
- New user deposit addresses are derived from the configured HD public key and permanently assigned to a user.
- No ownership proof is requested for the source wallet. Deposits are attributed by the OneX deposit address that receives the tokens.
- Incoming finalized transfers are grouped into a 60-minute batch. Multiple transfers may complete the same batch.
- A batch is eligible for credit only when its total is between 70 and 140 BSC-USD, the user will remain at or below 300 One-Val, the weekly rule is satisfied, and common reserves are sufficient.
- A valid batch held by the seven-day rule is automatically retried after its release time. Every retry rechecks current stock and reserves.
- Recharges consume `common.inactive_init_asset` first and `common.backed_units` only for the remainder.
- Deposit addresses are consolidated individually at 70 BSC-USD or when the oldest unswept finalized deposit reaches 30 days.
- A system sale liquidates the user's entire One-Val balance, deducts the configured fee, and pays the net amount in BSC-USD. A successfully confirmed disbursement counts toward the 90-day rolling cooldown.
- UTC (+0) is used for all new database timestamps and worker scheduling.

## P2P accounting

- `priceValue = sender.balance / sender.init_asset` is derived from the sender only.
- `amountUnits = requestedAmount / priceValue` and `receiverAmountUnits = amountUnits - receiverFee` are measured in initial-asset units.
- The sender's new `init_asset` is recalculated from the sender's new One-Val balance divided by `priceValue`.
- The recipient retains its existing `init_asset`; the recipient's new basis is `old_init_asset + receiverAmountUnits`. Do not reprice the recipient's historical balance at the sender's price.
- The recipient's One-Val balance increases by `receiverAmountUnits * priceValue`.
- The P2P initial-asset conservation check is: sender basis change + recipient basis change + fees allocated to common reserves = 0, subject only to database precision rounding.

## Database

This version defines the **final schema for a first deployment**. It intentionally does not migrate or backfill legacy tables. Create a new, empty MySQL database before starting this version. `initDbIfEmpty()` creates the required tables and verifies required columns; it does not alter an existing legacy schema.

Do not run this code against a database containing older OneX table definitions unless you have independently reviewed and prepared that database.

## Configuration

1. Copy `.env.example` to `.env` and configure MySQL, SMTP, admin credentials, BSC RPC endpoints, treasury address, token contract, public deposit HD key, and the initial reserve.
2. `STOCK_LIMIT` initializes `common.total_units_price`; `INITIAL_BACKED_UNITS` initializes `common.backed_units` on the first database creation. It defaults to `0`, so set it to the initial-asset reserve that is actually available before enabling recharge credits. It must not exceed `STOCK_LIMIT`. No reserve is auto-invented.
3. Copy `.env.disbursement.example` to `.env.disbursement`. Keep the treasury private key in this separate file, accessible only to the disbursement worker account.
4. Copy `.env.sweeper.example` to `.env.sweeper`. Keep the deposit HD private extended key and the separate gas-funder private key in this file, accessible only to the sweeper account.
5. Never commit or distribute real `.env` files, extended private keys, seed phrases, or wallet private keys.
6. Configure `BSC_DEPOSIT_XPUB` and its corresponding `BSC_DEPOSIT_XPRV` for the same non-hardened derivation branch. Keep the XPRV out of the HTTP server process.

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
npm start       # HTTP API and BEP-20 deposit scanner
npm run sweep   # Separate deposit-address consolidation worker
npm run disburse # Separate treasury disbursement/refund worker
```

Enable each blockchain process only after its environment file, RPC, wallet addresses, and balances have been verified. Do not enable mainnet sends while testing business logic.

## Important endpoints

- `POST /app/user-last-stock`: returns One-Val balance, P2P fee rate, and the user's OneX deposit address.
- `POST /app/recharge`: returns deposit instructions and limits. It does not create a pre-payment order.
- `POST /app/recharge/status`: returns the user's latest or specified deposit batch status.
- `POST /app/set-payout-address`: lets the user declare the address that will receive a system-sale payout. OneX does not prove source-wallet ownership.
- `POST /app/near-transfer`: user-to-user P2P or a user sale to OneX. OneX cannot be the sender.
- `POST /app/disbursement/status`: returns the status of a user's system-sale request.
- `POST /admin/unlock-disbursement`: requeues an expired, unsigned disbursement for the isolated worker after admin authentication and liquidity checks.
- `POST /admin/recharge/credit`: records an exceptional administrator-approved credit for a support-held recharge batch. It still enforces weekly cooldown, stock cap and common reserves.
- `POST /admin/recharge/refund`: queues a full administrative refund of a support-held recharge batch. Network gas is paid in BNB separately; no BSC-USD network fee is deducted by this route.

## Tests and production readiness

`npm run check` validates JavaScript syntax. `npm test` runs the business-rule unit tests. These checks do not replace MySQL integration tests, BNB Smart Chain testnet exercises, SMTP tests, or a full reconciliation rehearsal before production.
