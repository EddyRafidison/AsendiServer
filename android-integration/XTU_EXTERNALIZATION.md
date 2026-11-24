# OneX XTU wallet externalization API

This guide describes the server contract for the native Android application. The current server archive contains the device-authentication Java helper, but not the complete Android application source or its screens.

## User request

Endpoint: `POST /app/xtu2wallet`

Required JSON body:

```json
{
  "user": "ACCOUNT_USERNAME",
  "pswd": "ACCOUNT_PASSWORD",
  "amount": "100.000000000000000000",
  "tkn": "OPAQUE_DEVICE_SESSION_TOKEN"
}
```

`amount` must be a decimal string with at most 18 decimal places and a gross minimum of `1` XTU. Do not send `to`, `destination`, a wallet address, a private key or a recovery seed. The server uses the fixed `auths.wallet_address` recorded at signup. The route requires the normal device-bound request signature headers documented in `README.md` and the current Android device-authentication protocol.

The service is available only when both `XTU_WITHDRAWAL_WORKER_ENABLED=true` and the admin-controlled XTU withdrawal gate is open. The request is accepted with HTTP 202 while the worker processes it. The response includes the unique `reference`, gross amount, estimated BNB gas cost and XTU equivalent, estimated 0.1% contract fee, estimated net amount and registered destination address. These values are estimates until the transaction is finalized.

### Request status

Endpoint: `POST /app/xtu2wallet/status`

```json
{
  "user": "ACCOUNT_USERNAME",
  "pswd": "ACCOUNT_PASSWORD",
  "reference": "XTUW0123456789abcdef0123456789abcdef",
  "tkn": "OPAQUE_DEVICE_SESSION_TOKEN"
}
```

The user can query only their own request. Status values include `queued`, `signed`, `submitted`, `confirmed`, `failed` and `manual_review`. The server returns the transaction hash and block number when available. A manual-review reason may be returned to the account owner; raw signed transactions and private key material are never returned.

## Fees and displayed amounts

The request amount is gross. The server subtracts the estimated BNB gas cost converted into XTU using the Chainlink BNB/USD feed. The contract then charges 0.1% on the remaining token transfer amount. The contract fee is retained in the XTU distribution wallet. The final user-received amount is the on-chain `Transfer` amount to the registered wallet, not the gross request.

The app should label the values separately:

- Gross XTU requested.
- Estimated BNB network fee and its XTU equivalent.
- Estimated contract fee (0.1%).
- Estimated net XTU to be received.
- Actual BNB gas cost, actual contract fee and actual net XTU after confirmation.

The normal internal P2P `tfees` must not be applied to this endpoint. The XTU contract fee is applied by the smart contract, not by backend pre-deduction.

## Transaction history

A confirmed externalization creates an `activities` row with `type=5`, `sender=USERNAME` and `receiver=USERNAME-WALLET`. The history endpoint `/app/transactions-history` returns `amount_xtu` as the actual net externalized XTU and `fees_xtu` as the combined actual gas-equivalent plus contract fee. It also returns the internal initial-asset fields and the saved individual `unit_price`. The `activities.fees` column for type 5 is not `tfees`; it represents the combined fee equivalent in initial-asset units so the existing history conversion remains consistent.

A pending request is not yet a completed history activity. Use `/app/xtu2wallet/status` to display its lifecycle until it reaches `confirmed` or `failed`.

## Admin gate

Endpoint: `POST /admin/withdraw/start`

```json
{
  "pswd": "ADMIN_PASSWORD",
  "pin": "ADMIN_PIN",
  "action": "start",
  "reason": "XTU wallet externalization period opened"
}
```

`action` accepts `start`, `stop` or `status`. A reason of 5–1000 characters is required for `start` and `stop`. The gate is stored in `xtu_withdrawal_control`, defaults to closed and is independent of BSC-USD individual/global disbursement controls. `start` also checks that the configured XTU contract, distribution wallet, key and chain ID are consistent.

A `stop` action prevents new user requests; already queued or signed transfers continue through safe reconciliation. The worker will not create a second distinct transfer when an RPC broadcast result is uncertain.


## Accounting behavior

The gross XTU request is converted to initial assets using the user's captured individual price. At reservation time, `common.total_units_price` is reduced by that initial-asset amount valued at the same individual price, and `common.backed_units` is reduced by the corresponding initial assets. These pending assets are not spendable from `common.inactive_init_asset`. Only after the XTU transaction is confirmed do they move into `common.inactive_init_asset`. If the transaction definitively reverts, the user principal and backing are restored, while the actual BNB gas cost remains an expense. The global `common.unit_price` remains monotone and cannot decrease.
