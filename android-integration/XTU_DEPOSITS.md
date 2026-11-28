# OneX XTU deposit API and Android integration

XTU deposits are a separate payment rail from Binance-Peg BSC-USD deposits. They must be requested and polled with `asset: "XTU"`; do not infer an XTU deposit from a BSC-USD transaction or route it through the BSC-USD scanner.

## Deposit configuration

Endpoint: `POST /app/deposit`

```json
{
  "user": "ACCOUNT_USERNAME",
  "pswd": "ACCOUNT_PASSWORD",
  "tkn": "OPAQUE_DEVICE_SESSION_TOKEN",
  "asset": "XTU"
}
```

The successful response identifies BNB Smart Chain Mainnet (chain ID 56), the XTU token contract, the OneX Hot Wallet destination, the registered sender wallet, 20-100 gross session limits, the one-per-seven-day OneX system-funded purchase rule (regardless of amount), seller-campaign funding availability and the separate first-credit-tranche cap, 0% contract transfer fee, OneX deposit fee and gas treatment. The app must display the exact destination and fee policy returned by the server. Users must send from the BSC address registered on their OneX account. The app must never request a wallet private key or recovery phrase.

## Availability

Endpoint: `POST /app/deposit/availability`, with the same authenticated body and `asset: "XTU"`. The response provides `deposit_allowed`, any hold reason, and the shared 20-unit collection minimum, 100-unit automatic credit tranche cap, and fixed 30-day dossier deadline. There is no rolling seven-day ceiling on incoming XTU amounts. A separate weekly rule allows one purchase funded from OneX system reserves per user in any rolling seven-day period, regardless of amount; that rule is shared with BSC-USD deposits. When the allowance has been used, an otherwise eligible deposit may still be credited exclusively from active seller-campaign reserves. An eligible seller explicitly opts in through `POST /app/join-system-sellers`; OneX then creates the campaign and commits 50% of that seller's principal under the eligibility rules. Seller funds are not locked without consent. The response also provides the separate first-credit-tranche cap (100 XTU by default), the `consolidation_minimum_batch_xtu` threshold (100 XTU by default) for a Hot Wallet-to-Distribution Wallet consolidation lot, the event-driven collection status, immutable 30-day expiry metadata and current OneX system-funding cooldown metadata. A transfer above 100 XTU is recorded normally; each automatic credit tranche is capped at 100 XTU and the remainder stays pending for FIFO reassessment until it is credited or reaches the fixed 30-day expiry. A pending deposit or a temporary restriction must be displayed as pending, not as a completed credit.

## Status

Endpoint: `POST /app/deposit/status`

```json
{
  "user": "ACCOUNT_USERNAME",
  "pswd": "ACCOUNT_PASSWORD",
  "tkn": "OPAQUE_DEVICE_SESSION_TOKEN",
  "asset": "XTU",
  "batch_id": "123"
}
```

The response distinguishes gross XTU detected, net amount received by the Hot Wallet, zero contract commission (gross = net), gross XTU returned to the system, credited XTU, gas allocated in BSC-USD/XTU equivalent, OneX deposit fee, batch status, hold reasons, source transfer hashes/log indexes and the Hot Wallet-to-Distribution-Wallet consolidation transaction. Keep each blockchain transaction reference as a separate audit item. The Android client must not treat a detected but unfinalized transfer as a completed deposit.

## Financial rules shown in the app

- The XTU contract applies a 0% token transfer commission. Incoming and outgoing transfer events must reconcile gross amount = net amount and fee amount = 0; the app must not display a contract commission.
- Incoming XTU is consolidated only after finality and only for identified deposit amounts. All identified XTU receipts, including amounts already reclassified to common reserves after 30-day expiry, remain protected and accounted for in the Hot Wallet custody register. They are consolidated FIFO only when the aggregate eligible net amount actually received by the Hot Wallet reaches at least 100 XTU. Expiry never forces a transfer below 100 XTU. The lot may contain multiple users’ batches, with gas allocated deterministically and auditable per source batch. The Hot Wallet's initial 100-billion-token supply and other non-deposit allocations are never swept. A custody consolidation must not change `common.xtu_wallets` or `common.total_units_price` a second time.
- Outside global disbursement, the OneX XTU deposit fee is 75% of the normal `tfees` rate. From the effective global-disbursement cutoff, both BSC-USD and XTU deposits are suspended under the same rule; post-cutoff transfers are recorded for control but do not create new deposit credits or obligations.
- Actual BNB gas is always imputed to XTU deposits that are processed before the cutoff. The estimated gas ceiling of 0.4 BSC-USD is a refusal/deferral threshold, not a fixed fee.
- Initial assets are calculated using the absolute global `common.unit_price`, not the user's individual price. The reserve allocator checks `inactive_init_asset`, seller reserve and eligible `backed_units` in that order.
- The global disbursement snapshot remains immutable. Obligations acquired before the cutoff continue through their existing dedicated registers; post-cutoff deposits do not create new XTU settlement obligations.
- XTU externalized to personal wallets locks equivalent BSC-USD cover without moving physical BSC-USD. Confirmed gross XTU returned to the system releases this cover and reduces `common.xtu_wallets`; pending transfers do not.

The API is the authoritative source for current availability and fees. Do not display or calculate any 60-minute deposit window. Show the per-dossier 30-day expiry and the pending amount/reason returned by the API.


## Unknown and deactivated XTU source transfers

An official XTU transfer from an unregistered sender is registered as automatic refund category A after finality. No user refund request, EIP-191/EIP-1271 challenge or prior administrator approval is required. The public legacy endpoints `POST /public/xtu/unknown-transfers/refund-challenge` and `POST /public/xtu/unknown-transfers/refund-request` return HTTP 410 and must not be used by the app.

If the sender belongs to a deactivated OneX account, uncredited XTU and each new official incoming transfer are routed to automatic refund category C; no XTU free balance is credited. The same-token refund is sent to the original sender address. A 1% off-chain retention is calculated per source event, estimated gas is deducted once per grouped payout, and the net minimum is 1 XTU. Each event must be finalized and pass its individual 30-minute hold. Amounts below the net minimum remain in custody indefinitely; they are not redirected to common reserves because of ordinary deposit expiry. The XTU contract charges 0% transfer commission. Genuine reconciliation anomalies may remain in `manual_review` and block signup until formally resolved with an audit record.
