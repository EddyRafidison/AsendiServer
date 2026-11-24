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

The successful response identifies BNB Smart Chain Mainnet (chain ID 56), the XTU token contract, the OneX Hot Wallet destination, the registered sender wallet, minimum/maximum values, rolling seven-day limit, first-credit-tranche cap, contract fee, OneX deposit fee and gas treatment. The app must display the exact destination and fee policy returned by the server. Users must send from the BSC address registered on their OneX account. The app must never request a wallet private key or recovery phrase.

## Availability

Endpoint: `POST /app/deposit/availability`, with the same authenticated body and `asset: "XTU"`. The response provides `deposit_allowed`, any hold reason, the 70 XTU minimum, 140 XTU maximum per user per rolling seven-day period, the separate first-credit-tranche cap (100 XTU by default), the 60-minute collection window and the seven-day automatic retry interval. A pending deposit or a temporary restriction must be displayed as pending, not as a completed credit.

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

The response distinguishes gross XTU detected, net amount received by the Hot Wallet, contract commission, gross XTU returned to the system, credited XTU, gas allocated in BSC-USD/XTU equivalent, OneX deposit fee, batch status, hold reasons, source transfer hashes/log indexes and the Hot Wallet-to-Distribution-Wallet consolidation transaction. Keep each blockchain transaction reference as a separate audit item. The Android client must not treat a detected but unfinalized transfer as a completed deposit.

## Financial rules shown in the app

- The XTU contract applies a 0.1% commission to external transfers. The only commission exemption is the exact Hot Wallet → Distribution Wallet transfer; the app should not imply that sending to the Hot Wallet is fee-free.
- Incoming XTU is consolidated only after finality and only for identified deposit amounts. The Hot Wallet's remaining token supply is never swept.
- Outside global disbursement, the OneX XTU deposit fee is 75% of the normal `tfees` rate. During an active global disbursement, the OneX deposit fee is zero.
- Actual BNB gas is always charged to the XTU deposit, including during global disbursement. The estimated gas ceiling of 0.4 BSC-USD is a refusal/deferral threshold, not a fixed fee.
- Initial assets are calculated using the absolute global `common.unit_price`, not the user's individual price. The reserve allocator checks `inactive_init_asset`, seller reserve and eligible `backed_units` in that order.
- The global BSC-USD snapshot remains unchanged. Initial assets bought with XTU after global activation are a separate category and are settled only in XTU.
- XTU externalized to personal wallets locks equivalent BSC-USD cover without moving physical BSC-USD. Confirmed gross XTU returned to the system releases this cover and reduces `common.xtu_wallets`; pending transfers do not.

The API is the authoritative source for current availability and fees. Never calculate or promise a credit time from the 60-minute grouping window alone.
