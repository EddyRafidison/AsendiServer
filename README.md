# OneX Server

Node.js backend for the OneX platform. The current payment rail accepts **Binance-Peg BSC-USD (BEP-20)** on BNB Smart Chain mainnet (chain ID 56). This token is not USDt directly issued by Tether.

## Public unit: XTU (Extended Unit)

XTU is the single public transfer and valuation unit of the OneX system. It is not a separately stored user-balance unit. All user, seller and internal reserve balances are stored in **initial assets**. The platform has one live public/global price, `common.unit_price`, expressed as XTU per initial asset:

```text
common.unit_price = common.total_units_price / common.backed_units
user_individual_price = effective_price(user_price_state, users_stock.balance, common.unit_price)
user_balance_xtu = users_stock.balance * user_individual_price
sender_initial_asset_amount = public_xtu_amount / sender_individual_price
```

XTU remains unique and public for P2P transfers, but each account has an effective individual price derived from its remuneration state, initial-asset principal, the current global price and the 300 XTU ceiling. Consequently, users with equal initial-asset balances may have different XTU valuations. A sender's individual price converts the gross public XTU amount into initial assets; the recipient receives net initial assets after recipient-paid `tfees` and is valued using the recipient's own individual price. Individual and global disbursements use the applicable user or participant price snapshot rather than imposing one global settlement price on every account.

`common.total_units_price` is the only common-reserve value field stored in XTU. `common.backed_units` is stored in initial assets, remains consumable above the protected administrative quota, and is also the denominator used by the global price. The 10% administrative portion remains included in `backed_units` and therefore participates in XTU valuation; it is protected from ordinary user funding, not excluded from price calculation.

## Internal accounting conventions

- `users_stock.balance` and `users_stock.run_balance` are initial assets. A one-time welcome credit, when enabled, is posted to the ordinary balance and recorded in `auths` and `activities`; it is not a separate withdrawable balance.
- `common.backed_units`, `common.inactive_init_asset`, `common.sys_inactive_init_asset`, `common.sellers_res` and `common.total_run_balance` are initial assets.
- `common.total_units_price` is XTU. `common.unit_price` is always recomputed as `total_units_price / backed_units` on every common snapshot; `backed_units` must remain strictly positive.
- `activities.amount` and `activities.fees` are initial assets. `activities.unit_price` preserves the effective price used for the transaction's asset conversion (for P2P, the sender's individual price). Where populated, `activities.fee_unit_price` preserves the public/global price used to value system tfees in common reserves. Historical transaction and fee XTU values must use their corresponding recorded prices.
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

`STOCK_LIMIT` and `INITIAL_BACKED_UNITS` default to 18,000,000. `SYSTEM_ADMIN_RESERVE_RATIO` defaults to 0.10. The initial administrative quota is therefore 1,800,000 initial assets and the initially distributable portion is 16,200,000. The administrative quota remains included in `backed_units` and contributes to the global price. Only its remaining unspent portion is protected from ordinary recharge and individual-disbursement use.

`common.sys_inactive_init_asset` is a cumulative ledger of initial assets spent administratively. It is not a spendable reserve and is not added to `inactive_init_asset`. An administrative expenditure of `amount` XTU uses the current global price:

```text
spent_initial_asset = amount / current_unit_price
total_units_price_after = total_units_price_before - amount
backed_units_after = backed_units_before - spent_initial_asset
sys_inactive_init_asset_after = sys_inactive_init_asset_before + spent_initial_asset
unit_price_after = total_units_price_after / backed_units_after
```

Because numerator and denominator decrease proportionally, the price remains unchanged, subject to storage precision. The operation cannot spend more than the remaining administrative quota and cannot leave `backed_units` at or below zero.

## Single registered Android device and device-bound sessions

One account has one active Android device registration in `auth_devices`. The Android app generates an ECDSA P-256 key pair in Android Keystore and a random installation `device_id`. The private key never leaves the device. The provided `android-integration/OneXDeviceAuth.java` helper also encrypts the opaque session token with an AES-GCM key held in Android Keystore (`saveSessionToken`, `loadSessionToken`, `clearSessionToken`). A new installation first calls `POST /app/device/challenge` with `{ user, device_id, device_public_key }`, where `device_public_key` is the standard Base64 encoding of the DER SubjectPublicKeyInfo. The server returns a one-time `challenge_id` and `challenge_message`. The Android app signs the exact UTF-8 challenge message using `SHA256withECDSA` and calls `POST /app/signin` with `{ user, pswd, seed, device_id, device_challenge_id, device_signature }`. The seed is required for the first device or whenever the presented device key differs from the currently registered one; a recognized device needs the password and a fresh device signature but not the seed.

A successful new-device registration replaces the single `auth_devices` row, rotates the opaque `tkn`, immediately invalidates the previous token, and records an `auth_device_events` audit entry. A durable email notification is written to `account_security_email_outbox`; if Telegram is linked, a message is written to `telegram_outbox` in the same transaction. The account-security email worker retries delivery. `DEVICE_SESSION_TTL_DAYS` defaults to 30 and must be between 1 and 90. Challenge and request nonces are short-lived and cleaned up automatically.

Every protected application request must include the opaque `tkn` in its existing request body and these headers: `X-OneX-Device-Id`, `X-OneX-Device-Timestamp` (13-digit Unix milliseconds), `X-OneX-Device-Nonce` (fresh random Base64URL value), and `X-OneX-Device-Signature` (Base64 ECDSA signature). The signed UTF-8 message is exactly:

```text
ONEX-API-DEVICE-V1\n<METHOD>\n<PATH_AND_QUERY>\n<TIMESTAMP_MS>\n<NONCE>\n<TKN>\n<SHA256_HEX_OF_THE_EXACT_HTTP_BODY_BYTES>
```

`PATH_AND_QUERY` must match the exact raw path and query sent in the HTTPS request. The final field is the lowercase SHA-256 digest of the exact request-body bytes transmitted by the Android client (including the `tkn` field). The HTTP server captures those bytes before JSON or URL-encoded parsing. The Android client must build the request body once, sign those same bytes with `OneXDeviceAuth.createRequestHeaders(...)`, and send those exact bytes without reserializing or changing them. Each nonce is accepted once; a request with a changed body, path, method, token, timestamp or nonce fails signature validation. The server stores only the SHA-256 hash of `tkn`; the raw token is returned only at sign-in. The old AES token derived from `password + username`, the old `User-Agent` equality check and the client-controlled `recon` bypass are no longer used. The current Android APK must implement the challenge and signing protocol and use the returned token helpers before it can use protected endpoints. The server archive contains a Java integration helper, not the complete Android application project or a rebuilt APK. Anyone who knows both the account password and seed can still attempt to replace the device again; device notifications are intended to alert the account holder to such a change.

## Recharges and shared BSC-USD treasury

All users send Binance-Peg BSC-USD directly to one shared OneX treasury address. There are no per-user deposit addresses, HD deposit keys or deposit sweeper. The fixed wallet address required at signup identifies the user: the scanner matches the `from` address from the token contract's BEP-20 `Transfer` event to `auths.wallet_address`. It deliberately uses the event's sender field, not `transaction.from`.

- `/app/user-last-stock` returns the shared treasury address as `deposit_addr` only while recharge is available to that account. It also checks the user's outstanding batches and returns `has_pending_recharge` as a boolean only; it does not expose a pending amount, batch ID, reason or session detail through that field. `/app/recharge` provides payment configuration and availability but does not independently return the address.
- An incoming event is accepted only for the approved Binance-Peg BSC-USD contract on BNB Smart Chain mainnet (chain ID 56), with the treasury as the `to` address. Transfers from a registered sender are grouped into that user's 60-minute recharge session. The initial grouped session must reach at least **20 BSC-USD**. The **100 BSC-USD limit applies only to the first credit tranche**, not to the amount accepted or to later tranches. A larger payment is recorded in full; OneX credits up to 100 BSC-USD initially, subject to available account and reserve capacity, and retains the uncredited remainder for automatic processing without a new 100 BSC-USD cap.
- Each recharge batch freezes the applicable `tfees` rate when its first finalized transfer is recorded. `tfees` are deducted only from each gross amount actually credited. No BSC network gas or consolidation fee is deducted from incoming recharges. A 20 BSC-USD gross session at 3% `tfees` produces 19.40 BSC-USD net credit.
- Partial credits are recorded individually in `users_usdt_recharge_credits`; the batch tracks the total received, already credited, refunded and remaining amounts. Each credit tranche has a unique sequence and financial reference. Retrying is idempotent and the oldest outstanding batch is processed first (FIFO).
- The 60-minute session window is separate from the seven-day cooldown applied only when a recharge needs ONEX system-funded reserves. Seller-funded portions are exempt from that weekly ONEX funding cooldown. A qualified remainder below 20 BSC-USD may still be credited later; the 20 BSC-USD minimum is not reapplied to each subsequent partial tranche.
- The resulting individual user valuation must not exceed 300 XTU, measured using the user’s effective individual price after the financial update. The 300 XTU ceiling also stops further remuneration growth; sales remain available to bring an over-limit account back below the ceiling. Funding priority is `common.inactive_init_asset`, then active seller lots in FIFO order, then `common.backed_units` above the remaining administrative quota. Pending disbursement reservations reduce system-funded capacity.
- A pending remainder has no guaranteed maximum processing time. The server retries automatically when the user's balance capacity, reserve availability, account status, cooldown and service conditions permit. Relevant balance changes mark the user's pending batches immediately due; reserve-related batches are also retried periodically. Incoming recharge amounts ordinarily cannot be cancelled or refunded. Refund exceptions are limited to a deposit received from an unknown sender address, an approved emergency at the user's request, or a user-requested pending remainder of at least 300 BSC-USD, subject to administrative approval and the outgoing refund fee/minimum rules, where the minimum net is twice the configured maximum BSC gas fee. Already credited amounts are never included in a pending-remainder refund.
- A Telegram notification is queued in the same database transaction that records each recognized finalized incoming payment. It identifies the payment, states the current processing/hold reason and gives a suitable next step (for example, wait for the 60-minute session to close, wait for account capacity or reserves, or contact support for an account restriction). The Telegram worker polls the outbox every second and retries transient delivery failures. Delivery requires the user to have linked an active Telegram account and Telegram to be reachable; an unlinked account cannot receive Telegram messages. Notifications do not imply a guaranteed credit time.
- No per-user token sweep or deposit-consolidation transaction occurs. The user's own wallet/provider fee for sending a deposit is not charged again by OneX.
- Funding priority is strictly `common.inactive_init_asset` first, then active seller lots in FIFO order, then `common.backed_units` above the remaining administrative quota. Pending disbursement reservations reduce system-funded capacity.
- Seller-funded credit transfers initial assets from the seller reserve to the recipient. The beneficiary's own active seller lot is excluded from the funding pool so a user cannot recycle their locked balance into their own recharge. It does not issue a second copy of the seller-funded amount.
- The OneX-funded recharge portion converts its net public XTU value to initial assets using the pre-operation global price. The recipient’s individual valuation and 300 XTU capacity are then checked independently. `inactive_init_asset` is consumed before seller lots; `backed_units` is touched only after both earlier sources are exhausted. Common snapshots then recompute the global price from their resulting `total_units_price` and `backed_units`.
- A weekly-ineligible user receives no partial ONEX-funded credit. A pending batch is retried so it may be funded by sellers or after the weekly cooldown.

### Durable BSC incoming-transfer scanner and reconciliation

The treasury watcher scans finalized BSC-USD `Transfer` logs to the shared treasury using `eth_getLogs` in bounded block ranges. An optional `BSC_WS_RPC_URL` subscription wakes the scanner faster when a new block arrives; it is only a latency hint, while the durable HTTP scanner remains the source of truth and performs recovery. MySQL stores the scan cursor, cursor block hash, finality metadata and periodic historical checkpoints (every 500 scanned blocks, plus the initial checkpoint when applicable). A chain inclusion is identified by a stable SHA-256 event identity derived from `(tx_hash, log_index, block_hash)`. Including the block hash is deliberate: the same transaction can be re-included after a chain reorganization at a different block or log index, and the new inclusion must not be confused with the abandoned one. The scanner validates the transaction receipt, event contents and canonical block hash before dispatching the recharge handler. It commits event handling before advancing the block cursor.

After a process restart or temporary RPC outage, the scanner resumes from the last fully scanned block. An unavailable RPC, incomplete `eth_getLogs` response, inconsistent receipt or MySQL failure leaves the cursor unchanged so the same range can be retried. The primary endpoint is tried first and the fallback endpoint can be used when it is unavailable. Reconciliation requires two distinct HTTPS RPC endpoints; duplicate URLs do not count as independent providers. The shared treasury address is not disclosed until the scanner has initialized a healthy persistent cursor and caught up to its current finalized head; it is hidden again during `manual_review` or while an initial historical scan is still catching up. Transfers from sender addresses not registered in `auths.wallet_address` are recorded in `bsc_unknown_incoming_transfers` and are never credited automatically.

A cursor/hash mismatch or a change in the persisted chain/token/treasury identity moves the scanner to `manual_review` and halts new automatic recognition. If the cause is a configuration change, restore the exact original Chain ID, token contract and treasury address before starting reconciliation. Administrators must use a read-only preview, not reset the cursor directly. The preview compares two RPC endpoints, locates the latest common canonical finalized checkpoint, and classifies each affected incoming event as `canonical`, `re_included`, `orphaned` or `unverifiable`. A missing receipt by itself is not proof that a transfer was orphaned: the original block must also be shown not to be canonical. RPC disagreement, ambiguous matching logs, missing evidence or non-finalized re-inclusions remain `unverifiable` and block commit.

An orphaned event that has already produced a financial effect cannot be committed until an administrator has applied a correcting financial ledger entry and recorded its `activities.reference` against that preview item. The resolve-event endpoint records the attestation and audit trail; it does not create the financial correction. Events that were never credited and have only unsigned queued refunds may be reversed safely during commit, including cancellation of those unsigned refunds and adjustment of their uncredited batch. Signed, submitted, completed or otherwise uncertain refunds require separate financial investigation and compensation. Re-included events are updated to the new canonical block hash, block number and log index while preserving their chain-incarnation identity; rescanning does not create a duplicate credit. The commit endpoint rechecks the RPC evidence, preview expiry, cursor and checkpoint immediately before atomically applying the reviewed changes and resuming the scanner. If any item remains `unverifiable`, or an orphaned financial effect lacks a compensation reference, commit is rejected.

Administrative recovery endpoints are:

- `POST /admin/bsc/incoming-scanner/status`: reads scanner health, cursor, checkpoint history and the latest reconciliation preview, including its item classifications, compensation references and current `can_commit` state.
- `POST /admin/bsc/incoming-scanner/reconcile/preview`: performs a read-only two-RPC analysis and stores a time-limited preview.
- `POST /admin/bsc/incoming-scanner/reconcile/resolve-event`: records the reference to a financial compensation already applied by an administrator for an orphaned event with financial impact.
- `POST /admin/bsc/incoming-scanner/reconcile/commit`: revalidates and commits a current preview, then resumes scanning from the selected ancestor checkpoint.
- `POST /admin/bsc/incoming-scanner/reconcile`: the former direct cursor-reset endpoint is disabled and returns HTTP 410; a preview and commit are required.

The recharge batch manager is a separate worker from the BSC scanner. It polls already recorded recharge batches at `USDT_RECHARGE_QUEUE_POLL_MS` (default 30 seconds), so a temporary scanner outage does not stop processing of previously verified and finalized events. It never credits a payment that the scanner has not verified. While `manual_review` is active, it holds any batch tied to an `orphaned` or `unverifiable` preview item, and it also holds batches when no current reconciliation preview exists; batches whose incoming events are independently confirmed as canonical or re-included may continue through the normal reserve, account-capacity and recharge rules. This worker separation does not bypass payment finality or reconciliation controls.

`activities.amount` and `activities.fees` are stored in initial assets. `activities.unit_price` freezes the transaction price. The history endpoint returns both the internal initial-asset fields and their historical XTU equivalents.

## Individual price remuneration and priority seller reserve

Each account has an individual remuneration cycle with a base price `A`, an individual rate `C`, and a target price `B`. The public/global XTU price remains common to the platform, but an account's recognized price follows that global price only until its individual target or 300 XTU account ceiling is reached.

For an eligible operation group, let `P` be the principal in initial assets immediately before the first operation in that group, `V` the eligible volume accumulated in the group, and `tfees` the volume-weighted fee rate actually applied to those operations. The individual target rate is:

```text
C = 3 * tfees * min(1, 2 * V / P)
B = A * (1 + C / 100)
```

The maximum `C` is `3 * tfees`. A purchase group counts net credited initial assets; a sale group counts gross initial assets debited from the account. Purchases and sales are accumulated separately. Several operations of the same direction may be grouped, and a new cycle starts as soon as that group's cumulative volume reaches at least `5% * P`. An operation group below 5% does not start a cycle. The first credited acquisition of a new account establishes its initial principal and initializes a cycle without dividing by a zero principal.

The new cycle's base `A` is the post-operation global XTU price. The new target `B` is recalculated from the grouped operation's volume and volume-weighted `tfees`. If an account's current cycle is `watching`, its recognized individual price is `min(global_price, B, 300 / principal)`. It therefore follows global price progression until B or the 300 XTU ceiling is reached. At B the account becomes `paused`; if the 300 XTU ceiling is reached first, it becomes `capped`. The recognized price remains frozen in either state until a new eligible operation group starts a cycle. An account already above 300 XTU is not repriced downward; its recognized price is frozen. While its state is `capped`, purchases are unavailable even if a partial sale has reduced the displayed valuation below 300 XTU. Eligible sale volume remains grouped, including after the group first reaches 5%, until the projected principal valuation at the current global price is strictly below 300 XTU; only then can the accumulated sale group start a new cycle. Purchases/recharges that would exceed 300 XTU are rejected or remain pending until capacity is available.

A threshold notice is queued in English when B or the 300 XTU ceiling is reached. The notice explains the account's current state and that same-direction partial operations are grouped until the 5% minimum is met. Welcome bonuses, administrative stock adjustments, seller-campaign activation and uncredited/pending deposits do not count as eligible purchase or sale volume. An individual sale to ONEX counts as a sale only after the BSC-USD payout is confirmed. The common-price worker processes upward threshold crossings so that each user's personal threshold is independently enforced.

A priority seller is eligible only after the individual remuneration target has been reached (`paused`) and the user's current main-account valuation is at least 20 XTU using the seller's individual recognized price. Activation commits 50% of the full principal balance to the seller reserve automatically; the user no longer selects a lock amount and no bonus threshold is checked. The public balance remains in the user's main stock while the reserved half is blocked through a seller reserve lot. A price cycle can activate only one campaign. The campaign and lot retain the activation-time individual price for payout valuation.

## P2P transfers and transaction fees

`POST /app/near-transfer` (also exposed through the app's public transfer contract) accepts a public XTU amount for ordinary user-to-user transfers. XTU remains one public unit. The sender's requested XTU amount is converted into initial assets using the sender's effective individual price. `tfees` are charged to the recipient by deducting them from the gross amount before the net initial assets are credited. The recipient's resulting account valuation uses that recipient's own individual price; therefore, two users with equal initial-asset balances may have different XTU valuations. No BSC gas transaction is needed for an internal P2P transfer.

The initial assets returned through `tfees` are added to common backing. Their XTU value is calculated using the public/global price immediately before the operation, and that value is added to `common.total_units_price`. This prevents a sender's personal price from changing the common reserve valuation. Recharges also deduct `tfees` from the gross deposit amount; incoming deposits do not require an outgoing BSC consolidation transaction.

## Individual and global disbursements

Both disbursement modes use the same user-facing request: `POST /app/xtu-transfer` with `dest=ONEX`. The client does not select the mode. The server selects it from the authoritative global-run state while holding the common-state transaction lock.

### Ordinary individual disbursement

The individual mode is an exceptional, non-periodic facility. It is disabled by default and accepts requests only while the administrator has explicitly opened intake through `POST /admin/individual-disbursement/control` after publishing a Telegram notice manually outside the server. The control defaults to closed; each opening requires an audit reason and a reference to the external notice. Requests are accepted in chronological order while the dedicated Disbursement Wallet has sufficient unreserved BSC-USD. If that wallet cannot cover the expected payout, the API responds with `transf: "insufficient res"`; an unavailable or administratively closed period responds with `transf: "disbursement unavailable"`. The ordinary minimum gross request is **200 XTU** by default (`DISBURSEMENT_INDIVIDUAL_MINIMUM_XTU`), and the account must have at least the same configured minimum in current individual valuation. A minimum 30-day cooldown remains between confirmed individual disbursements, but it is not a monthly schedule or a promise that a period will open every month. A valid request also requires a fixed payout wallet, no active seller commitment and no unresolved payout. The user's gross XTU request is converted using that user's effective individual price captured under the `common_state` lock. Recipient-paid `tfees` are deducted from the gross amount, then the estimated BSC gas cost is separately deducted from the remaining BSC-USD payout. The returned `tfees` are credited to common backing in initial assets; their XTU reserve value is calculated with the public/global price immediately before settlement, not with the participant's individual price. No global bonus is paid. The accepted amount and individual price are persisted; later common-price changes do not reprice the payout.
An administrative requeue of an already accepted disbursement (`POST /admin/unlock-disbursement`) does not impose a separate 10 BSC-USD minimum; it only requires a valid positive payout amount and rechecks the original account, reservation, address and dedicated Disbursement Wallet conditions.

### Global disbursement

Global disbursement is a definitive administrative decision, not an automatic mass-payout command. `/admin/start-global-disbursement` records the decision, the administrator-selected notice channel/reference, the announcement time, planned activation time, request-window length and bonus rate. The administrator is responsible for informing users by the channel selected; the notice need not be sent by the server. The planned activation must be at least seven full calendar days after announcement. The date arriving does not activate the mode: an administrator must explicitly call `/admin/activate-global-disbursement` after the notice period and after pending operations are reconciled.

The primary request period is **90 days minimum** after explicit activation. `GLOBAL_DISBURSEMENT_REQUEST_WINDOW_DAYS` defaults to 90 and may only increase it (maximum 365); any value below 90 is rejected. A further extension of **30 days minimum** follows the primary period. `GLOBAL_DISBURSEMENT_EXTENSION_DAYS` defaults to 30 and may increase the extension (maximum 365); values below 30 are rejected. At activation, the system snapshots each participant's individual base price, remuneration rate, target and effective settlement price, records every participant and both deadlines, then suspends new recharges and user-to-user P2P transfers. The run-level global price is retained only as a common reference; it is not the settlement price for every participant. Individual requests to `ONEX` remain open through the end of the extension. The minimum gross request is **1 XTU throughout both global request periods**. A user may submit another request against a remaining balance after a previous request is settled. Each request is stored as `disbursement_mode='global'` with its `global_run_id`, the participant's frozen individual price, recipient-paid `tfees` deducted from the gross sale, and the estimated BSC gas cost deducted separately from the BSC-USD payout.

The global bonus defaults to `FEES` when `GLOBAL_DISBURSEMENT_BONUS` is absent or empty and is capped at 10%; an explicit value above 10% is rejected. It is calculated on the participant's net XTU amount after recipient-paid `tfees`. For example, a 200 XTU gross request at 3% `tfees` first deducts 6 XTU, leaving 194 XTU; a 3% global bonus is then calculated on that net amount and adds 5.82 BSC-USD at a 1 XTU individual snapshot price. The estimated BSC network fee is deducted separately from the recipient's BSC-USD payout. **The bonus applies only to requests accepted during the primary period.** Requests accepted during the extension receive no bonus. A request accepted during the primary period retains its bonus even if blockchain payment is completed during the extension. The estimated gas amount is deducted from the token payout and reconciled against the actual receipt; the actual network cost is included in common reserve accounting. `tfees` returned to the system are added to common backing, while their XTU reserve value is calculated at the public/global price immediately before settlement. The bonus is funded from the protected administrative quota, subject to reserve and treasury-liquidity checks.

At the end of the extension the server closes the request window. Previously accepted jobs continue to be processed and remain protected, including accepted but unpaid jobs. No automatic request or debit is created for an account that did not submit one. Unclaimed balances and residual balances not covered by accepted requests may only be reallocated through a separately recorded administrative decision with traceability. The run becomes `completed` only after accepted payout jobs and required participant resolutions are settled.

The global mode remains effective after the request window is closed and after the run is completed/resolved; new recharge, ordinary P2P and individual-mode admissions do not resume automatically. The administrator must not use the global flag as an automatic trigger: explicit announcement and explicit activation are required. Already accepted disbursements continue to be processed even if an admission flag is later disabled.

## Hot Wallet reserves and Cold Wallet sweeps

The Hot Wallet is the shared incoming-payment address and the operating intermediary for uncredited recharges, refunds (including refunds of unknown incoming senders) and seller payouts. Its on-chain BSC-USD balance is not the same as its free liquidity. `treasury-liquidity.js` calculates the protected reserve from the authoritative ledgers without counting the same liability twice: uncredited recharge `remaining_amount`, reserved recharge refunds, unknown transfers in pending/refund/review states (including `resolved_uncredited` amounts still held by the system), seller lots' `payout_pending_initial_asset × immutable unit_price`, orphan refund jobs not linked to a batch or unknown transfer, and already signed/submitted Cold Wallet sweeps. Batch-linked refunds are already represented by `reserved_refund_amount`; seller payout batches are not summed again because their obligation is already represented by seller reserve lots. A pending sweep is itself reserved until its transfer block is finalized and indexed by the incoming scanner, so Hot Wallet refunds and seller payouts cannot spend funds already committed to the Cold Wallet transfer.

The Hot Wallet's free BSC-USD liquidity is:

`max(0, on-chain Hot Wallet BSC-USD − all protected obligations − USDT_TREASURY_MIN_OPERATING_BSC_USD)`.

When `USDT_BEP20_COLD_WALLET_ADDRESS` is configured and free liquidity is at least `USDT_COLD_SWEEP_THRESHOLD_BSC_USD` (default 500), the isolated `treasury-worker.js` transfers `USDT_COLD_SWEEP_PERCENT` (default 90%) of that free amount to the Cold Wallet. The remaining 10% of the free amount stays in the Hot Wallet, in addition to the protected obligations and configured operating minimum. If the Cold Wallet address is empty, the sweep is disabled. The worker reads the Hot Wallet token balance at a finalized BSC block and requires the healthy incoming scanner to have indexed that same block before sweeping. Hot Wallet refunds and seller payouts use the same finalized-balance/scanner check, and pending cold sweeps remain reserved until their transfer block is finalized and indexed. The worker also checks the BNB gas balance and fee ceiling, persists signed transactions and resumes/reconciles them after restart. A pending or uncertain sweep prevents another sweep. The Cold Wallet's private key must never be stored on the server.

A separate Disbursement Wallet funds individual and global user payouts. Individual intake is administratively opened/closed and first-come-first-served against its unreserved BSC-USD balance. Global activation is rejected unless the Disbursement Wallet can cover the full snapshotted BSC-USD liability. The Hot Wallet and Disbursement Wallet have separate addresses and private keys; the Cold Wallet is an address-only destination from the server's perspective. The administrative endpoint `POST /admin/common-history` returns the 50 latest `common` rows together with a `hot_wallet` object containing the Hot Wallet on-chain BSC-USD/BNB balances, protected reserve breakdown, total protected amount, operating minimum and calculated free liquidity/sweep eligibility.

## Refunds, gas and cumulative fees

Before any outgoing BSC-USD treasury payout, refund, seller payout or disbursement is signed, the worker calls `eth_estimateGas` for the exact ERC-20 transfer data and values the estimate using the live Chainlink BNB/USD feed on BNB Smart Chain Mainnet (`BSC_BNB_USD_FEED_ADDRESS`). A transfer is signed and broadcast only when its estimated cost is at or below `BSC_MAX_TX_FEE_BSC_USD` (default and hard maximum: 0.4 BSC-USD); otherwise the job remains queued without a signed transaction or hash and is re-evaluated on later worker cycles. `BSC_MAX_TX_FEE_BSC_USD` is validated when the HTTP server starts, and values above 0.4 are rejected. The estimate is not a guarantee of the final on-chain fee.

The `bsc-price-oracle.js` module reads `decimals()` and `latestRoundData()` from the Chainlink BNB/USD feed every 60 seconds by default, checks that the price is positive and that `updatedAt` is not older than `BSC_PRICE_MAX_AGE_SECONDS` (300 seconds by default). If the feed or RPC is unavailable or the quote is stale, new outgoing transactions remain queued until a fresh quote is available; a stale cached quote is never silently reused. Deposits go directly to the shared treasury and are not swept from individual addresses.

## Administrative stock endpoints

- `POST /admin/update-user-stock` credits one user through the same reserve-priority top-up allocator used by recharge processing. `amount` is public XTU/BSC-USD; the route converts it using the current global price. The normal automatic minimum is bypassed, but the user cap, ONEX-funded cooldown/cap, transaction fees, BSC recovery and administrative reserve floor remain enforced.
- `POST /admin/update-common-stock` is exclusively an administrative expenditure. `amount` is XTU; it is converted using the current global price and debited proportionally from `total_units_price` and `backed_units`. The initial-asset basis is added to `sys_inactive_init_asset`. It does not credit a user and is not a buyback or new issuance.

## Database and deployment

This is a target schema for a first deployment, not an automatic migration. Create a new empty MySQL database. Old `users_stock.init_asset` and `common.sellers_init_asset` fields are not part of the target schema. Do not attempt to reuse old balance snapshots without a separately designed, audited migration. All amounts must be converted from their historical unit according to each table's old schema and historical transaction price before any data migration.

## International signup and identity documents

`POST /app/signup` is available to eligible adults regardless of the country from which they register, subject to applicable local law. The IP country lookup is diagnostic only: it does not determine nationality or residence country, select the required identity document, or approve or reject signup.

The signup request must include both `nationality` and `residenceCountry` as ISO 3166-1 alpha-2 country codes. The identity-document rule is based on these two declared values:

- If `nationality` and `residenceCountry` are the same, submit a national identity card issued by that country where available. A passport is also accepted where the country does not issue a national identity card or the applicant uses a passport as their identity document.
- If `nationality` and `residenceCountry` differ, the applicant is treated as a foreign resident and must submit a valid passport.

This rule applies to all countries; CNI is not a Madagascar-only document category. The canonical `identityType` values are `NATIONAL_ID` and `PASSPORT`. The legacy API value `CNI` is normalized to `NATIONAL_ID`. If `identityType` is omitted, the server defaults to `NATIONAL_ID` for a national resident and `PASSPORT` for a foreign resident. Submit the document number through `identityNumber` and the required document image through `identityImage1`; `identityImage2` is optional for additional document details. Each image is limited to 3 MiB after base64 decoding. Former request keys `cni`, `cniimg1` and `cniimg2` remain accepted as API compatibility aliases only; database storage uses the generic `identity_document_number` column.

The fresh `auths` table stores `nationality`, `residence_country`, `identity_document_type` and the encrypted `identity_document_number` as required fields. Create the database from the current `db.js` schema before starting the server. This pre-deployment project uses a fresh-schema approach and intentionally contains no SQL migration or legacy-data backfill for these fields.
## Optional Telegram notifications

- Telegram is optional. Users can sign in and use financial features without linking a bot account. Transactional notifications are sent through Telegram only when both `tg_userId` and `tg_chat_id` are linked.
- `/app/signin` returns `tg_botLink`: the plain bot link for an already linked user, or a deep link containing a one-time 10-minute token for an unlinked user. The Android app can open this link from its Telegram button.
- Run exactly one Telegram long-polling worker with `npm run telegram`. It handles `/start` association, private-chat block events and the temporary outbox. Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_BOT_USERNAME` in `.env`.
- Telegram messages are English-only. SMTP remains enabled for the new username after signup, temporary recovery passwords, and `/app/contact-onex`. The existing identity-document email to the account-verification administrator remains a separate signup-review workflow, not a transaction notification.
- The `notifs` table and the legacy feed endpoints are not part of the current schema. Financial tables remain the source of truth; `telegram_outbox` is only a delivery queue and not a notification history.

## Account activation, email and automatic cleanup

Signup normalizes email addresses by trimming whitespace and converting them to lowercase. An email address can belong to only one account. The signup email sent to the user contains only the generated username; OneX does not send an email-verification link or code. The user chooses their password during signup. A successful sign-in updates `auths.last_login_at_ms`, which is the source of truth for whether the account has ever connected. Because no verification link or code is used, this is an operational first-login indicator, not cryptographic proof of mailbox ownership.

`auths.account_active` is the administrative access switch. `POST /admin/deactivate-account` requires the target username and a 5–1000 character reason; it records the reason and administrator action in `auths` and `account_access_events`. After the account is marked inactive, every outstanding recharge batch with an uncredited remainder is immediately moved to `pending_support` with reason `account_deactivated`; its transfer events are updated and a Telegram status notification is queued for linked accounts. Any new finalized incoming transfer from that wallet while the account remains disabled is also recorded in a `pending_support` batch with the same reason and is not credited. These held batches are excluded from normal retry polling while the account remains deactivated. The account-state update commits before the recharge-batch hold synchronization; even during that short interval, the credit path locks and checks `auths.account_active`, so no new credit can succeed after deactivation commits. `POST /admin/activate-account` re-enables the account, removes only the `account_deactivated` hold reason, sets the remaining batches due (not earlier than an unexpired 60-minute collection window), queues a reactivation notification and immediately wakes the recharge processor. The processor then rechecks FIFO order, the minimum, the global cutoff, account balance capacity, cooldown and reserve availability; reactivation does not guarantee immediate credit. Deactivated accounts receive `{ "auths": "deactivated" }` after presenting the correct password and cannot perform authenticated account operations. User-facing financial and account endpoints also require a successful first login. Both administrative endpoints use the existing administrator credentials (`pswd` and `pin`) and accept `username` (or `user`); activation may also include an optional audit `reason`.
The optional welcome credit is evaluated exactly once on the first successful sign-in. `WELCOME_BONUS_BENEFICIARIES` defaults to `1000` and selects the earliest successful registrations using a gap-free transactional sequence; setting it to `0` disables the beneficiary group. `WELCOME_BONUS_AMOUNT_XTU` defines the amount and defaults to `0`, which disables financial credits until an operator deliberately configures a positive amount. The server records `pending`, `credited`, `disabled`, `not_eligible`, `previously_credited`, `reserve_unavailable` or `balance_limit` so a later sign-in cannot repeat the decision or award. A credited amount is funded through the existing distributable system-reserve accounting and is written to `activities` as type `4`. `WELCOME_BONUS_CLAIM_SECRET` is a persistent HMAC key used for pseudonymous email/document claim fingerprints; keep it unchanged across deployments and backups. When omitted, the database password is used as the fallback key.

`cleanup()` runs at startup and then hourly. It considers accounts for deletion only when they have never successfully signed in and are at least seven days old; administratively deactivated accounts are excluded. Before deletion, the routine locks and rechecks the account and checks balances, seller reserves, recharge/deposit records, disbursements, refunds, activities and other financial history. Accounts with any such records or inconsistent stock data are retained in `account_cleanup_holds` for review. For a safely deletable account, the login/account profile and non-financial temporary records are removed, but the public wallet-address registry is retained permanently with its historical account association. A wallet address is never released for another account, including after account deletion. Financial and blockchain audit records are never cascade-deleted.

The BSC wallet is mandatory at signup, format/checksum validated, and permanently bound to the account. OneX does not cryptographically verify ownership or control. The address is used both to identify incoming transfers and as the destination for outgoing payouts, refunds and disbursements. Accepted payout jobs snapshot the same fixed address; users cannot change it through `/app/set-payout-address`.


Telegram delivery note: the outbox provides at-least-once delivery. If Telegram accepts a message but the worker stops before recording `sent`, the message can be delivered again after restart. Transaction references in messages make such a duplicate recognizable; Telegram `sendMessage` does not provide a general exactly-once idempotency key.

## Database

This version defines the **final schema for a first deployment**. It intentionally does not migrate or backfill legacy tables. Create a new, empty MySQL database before starting this version. `initDbIfEmpty()` creates the required tables and verifies required columns; it does not alter an existing legacy schema.

Do not run this code against a database containing older OneX table definitions unless you have independently reviewed and prepared that database.

## Configuration

1. Copy `.env.example` to `.env` and configure MySQL, SMTP, admin credentials, BSC HTTPS RPC endpoints, an optional secure WebSocket RPC endpoint, shared treasury address, token contract, Chainlink feed and the initial reserve.
2. By default, a new database starts with `common.total_units_price=18000000`, `common.backed_units=18000000` and the derived `common.unit_price=1`. `STOCK_LIMIT` and `INITIAL_BACKED_UNITS` can override the initial amounts; `INITIAL_BACKED_UNITS` defaults to `STOCK_LIMIT`, must cover the initial 10% administrative quota, and must correspond to assets actually available to the system. When the configured values differ, the initial price is derived as `total_units_price / backed_units`, not hard-coded to 1.
3. Set `STOCK_LIMIT=18000000`, `INITIAL_BACKED_UNITS=18000000` and `SYSTEM_ADMIN_RESERVE_RATIO=0.10` in `.env`. `GLOBAL_DISBURSEMENT_BONUS` may be omitted to inherit `FEES`; an explicit value must be between 0 and 10. Keep `GLOBAL_DISBURSEMENT_REQUEST_WINDOW_DAYS` at 90 or higher and `GLOBAL_DISBURSEMENT_EXTENSION_DAYS` at 30 or higher. Remove the retired `RECHARGE_BSC_FEE_RECOVERY_USD` setting. Set `BSC_MAX_TX_FEE_BSC_USD` to a value from 0 through 0.4 (default 0.4; larger values prevent the HTTP server from starting). Keep the default `BSC_BNB_USD_FEED_ADDRESS` set to the official BNB/USD feed on BNB Chain Mainnet, or replace it only with a verified Chainlink feed on chain ID 56. Configure `BSC_PRICE_REFRESH_INTERVAL_MS` (default 60000) and `BSC_PRICE_MAX_AGE_SECONDS` (default 300); no manually maintained BNB/USD environment quote is required; remove the retired `BNB_USD_PRICE` variable from existing environment files.
4. Copy `.env.treasury.example` to `.env.treasury` and `.env.disbursement.example` to `.env.disbursement`. `BSC_TREASURY_PRIVATE_KEY` must match `USDT_BEP20_TREASURY_ADDRESS`; `BSC_DISBURSEMENT_PRIVATE_KEY` must match `USDT_BEP20_DISBURSEMENT_ADDRESS`. Keep both files outside source control and restrict access to their respective workers. The Cold Wallet private key is never installed on the server. Leave `USDT_BEP20_COLD_WALLET_ADDRESS` empty to disable automatic sweeps; set the minimum operating balance deliberately rather than assuming that the default `0` is a recommended production reserve.
5. Before accepting deposits, set `USDT_INCOMING_START_BLOCK` to a safe block number at or before the first payment that OneX must recognize. If it is left blank on the first startup, the scanner initializes at the then-current finalized block and will not index earlier deposits. After initialization, the persistent MySQL cursor controls recovery; changing the environment variable does not reset an existing cursor.
6. Never commit or distribute real `.env` files, extended private keys, seed phrases, or wallet private keys.

The Hot Wallet must hold sufficient BSC-USD for recharge obligations, refunds and seller payouts, and BNB for its transaction gas. The dedicated Disbursement Wallet must separately hold BSC-USD for individual/global payouts and BNB for their gas. Users must send incoming deposits directly from the fixed wallet address registered on their account.

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
npm run disburse  # Dedicated Disbursement Wallet worker for individual/global payouts; Hot Wallet refunds and seller payouts
npm run treasury  # Hot Wallet reserve monitor and automatic Cold Wallet sweep
```

Set `USDT_SELLER_PAYOUTS_ENABLED=true` only when seller treasury payouts are ready. Enable each blockchain process only after its environment file, RPC, wallet addresses, and balances have been verified. Do not enable mainnet sends while testing business logic.

## Request encoding

- Express performs standard `application/x-www-form-urlencoded` decoding. The server does not replace spaces with `+` and does not rewrite submitted passwords, seeds, names or free-form values.
- Android clients should use a standard form encoder. In URL-encoded forms, a literal plus sign must be encoded as `%2B`; a space is normally encoded as `+` or `%20` by the encoder. Do not manually replace spaces or plus signs after encoding.
- JSON requests preserve spaces and plus signs as literal characters and are preferred for values where form-encoding ambiguity is undesirable.

## Important endpoints

`POST /app/signup` requires `wallet_address`. Invalid EVM addresses return `{ "auths": "addr error" }`; a wallet address already used by a current or deleted account returns `{ "auths": "addr used" }`. The wallet is fixed after signup and applies to incoming payment identification and outgoing payouts. `POST /app/set-payout-address` is read-only. Unknown incoming treasury transfers can be reviewed through `/admin/bsc/unknown-transfers/list` and `/admin/bsc/unknown-transfers/resolve`. Scanner health and forensic recovery are available through `/admin/bsc/incoming-scanner/status`, `/reconcile/preview`, `/reconcile/resolve-event` and `/reconcile/commit`. The former direct `/reconcile` cursor-reset endpoint is disabled with HTTP 410; it must not be used to bypass event review or financial compensation checks.

- `POST /admin/bsc/incoming-scanner/status`: reads the durable incoming-scanner cursor, health state, checkpoint history and most recent preview.
- `POST /admin/bsc/incoming-scanner/reconcile/preview`: compares two distinct RPC endpoints and stores a read-only, time-limited event classification preview.
- `POST /admin/bsc/incoming-scanner/reconcile/resolve-event`: records an existing compensating `activities.reference` after an administrator has already applied and checked the correcting financial entry; it does not perform the correction itself.
- `POST /admin/bsc/incoming-scanner/reconcile/commit`: rechecks evidence and atomically commits a safe preview before resuming the cursor.
- `POST /admin/bsc/unknown-transfers/list` and `POST /admin/bsc/unknown-transfers/resolve`: review unmatched sender addresses and assign only to an account whose fixed registered wallet exactly matches the event sender, retain without credit, or queue a refund to the event sender.
- `POST /app/user-last-stock`: returns the user's current XTU display balance calculated from the initial-asset principal and effective individual price, together with `balance_initial_asset`, `global_unit_price`, individual `unit_price`, `base_price`, `remuneration_rate`, `target_price`, `remuneration_status` (`watching`, `paused` or `capped`), `price_snapshot_mode` (`live_individual` or `global_disbursement`), `maximum_user_stock`, `stock_limit_reached`, `stock_purchases_allowed`, remaining stock capacity, the P2P fee rate, the shared OneX treasury address (as `deposit_addr`) when recharge is available, seller-campaign fields, and `has_pending_recharge` (`true`/`false`). The boolean is calculated from outstanding recharge batches and never exposes the pending amount. `run_balance` is also valued at the same effective individual price. During an effective global disbursement, the endpoint uses the participant's immutable individual settlement snapshot for the returned balance and price fields; it does not recalculate the price from later common-reserve movements.
- `POST /app/recharge`: returns the BEP-20 payment configuration, recharge limits and service availability only. It does not create or return a deposit address.
- `POST /app/recharge/availability`: returns only `available_reserve_xtu`, `minimum_recharge_amount_bsc_usd` and `maximum_recharge_amount_bsc_usd`. It is designed for lightweight authenticated polling and does not return service-availability flags or deposit addresses. The application obtains recharge suspension/availability from the existing account and recharge endpoints. The server shares a one-second cache across clients so polling does not lock reserve accounting rows.
- `POST /app/recharge/status`: returns the user's latest or specified deposit batch status.
- `POST /app/recharge/refund-request`: records a user-requested exceptional review for an uncredited pending remainder. Requires `batch_id` and a reason of at least 10 characters. It does not cancel the recharge or create a payout. Remainders of at least 300 BSC-USD use the threshold category; smaller remainders are recorded as emergency requests and need explicit administrative approval.
- User refund requests are directly linked one-to-one to refund records through `user_request_id` and `refund_id`. The request lifecycle is audited from `pending_admin` through `approved_queued`, `signed`, `submitted`, and the terminal or review states `completed`, `failed` or `manual_review`.
- Administrative approval reserves the uncredited batch remainder in `reserved_refund_amount`; it does not increase `refunded_amount`. Only a confirmed BSC-USD transfer moves the reserved gross amount into `refunded_amount`. A finalized reverted transaction releases the reservation and restores the full gross amount to `remaining_amount`; an uncertain or mismatched transaction stays reserved for manual reconciliation.
- `user_usdt_refund_request_events` records each request transition and its actor, reason, gross/fee/net amounts and transaction hash. `admin_payment_resolutions` is linked directly to both the request and refund record. Unique indexes prevent one request from creating multiple refund records.
- `POST /admin/user-info` returns a non-secret administrative account and financial overview, including account state, balances, pending recharge batches, refund requests, refunds, disbursements and seller payouts. Authentication secrets and recovery phrases are never returned.
- `POST /app/set-payout-address`: read-only compatibility endpoint; returns the fixed wallet saved at signup and never changes it.
- `POST /app/xtu-transfer`: user-to-user P2P or a user sale to OneX. OneX cannot be the sender. P2P fees are paid entirely by the recipient.
- `POST /app/disbursement/status`: returns the status of a user's system-sale request.
- `POST /admin/unlock-disbursement`: requeues an expired, unsigned disbursement for the isolated worker after admin authentication and liquidity checks.
- `POST /admin/individual-disbursement/control`: administrator-only `status`, `open` or `close` control. Opening requires a reason and the reference to a manually published Telegram notice; the endpoint does not send Telegram announcements.
- `POST /admin/common-history`: returns up to 50 most recent `common` snapshots and `hot_wallet` reserve/liquidity details.
- `POST /admin/recharge/credit`: records an exceptional administrator-approved credit for a support-held recharge batch and may bypass the automatic initial 20 BSC-USD session minimum and the 100 BSC-USD first-tranche cap after support review. It still enforces the 300 XTU stock cap, the weekly cooldown when ONEX reserves are needed, and reserve availability; inactive reserve is consumed first, seller lots second and backed reserve last.
- `POST /admin/recharge/refund`: approves and queues a persisted user refund request using `request_id`, an administrative `reason`, and `emergency_approved=true` only for an emergency request. The refund is limited to the uncredited remainder; already credited amounts are excluded. No `tfees` is charged on the uncredited remainder. The outgoing Chainlink-based BSC gas estimate is deducted, the 0.4 BSC-USD gas ceiling applies, and the net refund must be at least twice `BSC_MAX_TX_FEE_BSC_USD` (0.8 BSC-USD at the default 0.4 cap). The endpoint does not accept an ordinary cancellation request.
- `POST /admin/update-user-stock`: applies an administrator-approved individual stock credit through the standard recharge allocator, preserving inactive-reserve → seller-lot → backed-reserve funding priority, system cooldown/cap, fees, cost recovery and the user balance ceiling. The automatic minimum is bypassed. Requires the configured administrator password and PIN.
- `POST /admin/update-common-stock`: records an administrative expenditure from the protected common allocation. `amount` is XTU / BSC-USD; the current unit price converts it to initial-asset basis, `total_units_price` decreases by `amount`, `unit_price` stays unchanged, and the spent basis moves from `backed_units` to `sys_inactive_init_asset`. Requires the configured administrator password and PIN.
- `POST /admin/send-temp-pswd`: issues a seven-digit temporary password by email; valid for 10 minutes and usable only to sign in and change the permanent password.
- `POST /app/join-system-sellers`: requests activation of a priority seller campaign.
- `POST /app/cancel-system-sellers`: requests cancellation; the unused seller reserve remains locked pending admin review.
- `POST /admin/unlock-system-seller`: releases the unused portion of a seller lot after administrative authorization.
- `POST /admin/deactivate-account`: blocks an account and persists the administrator's reason.
- `POST /admin/activate-account`: restores account access and records the activation event.

## Tests and production readiness

`npm start` also launches the seller lifecycle worker in-process; its MySQL advisory lock prevents concurrent processing by duplicate instances. `npm run check` validates JavaScript syntax. `npm test` runs the business-rule unit tests. These checks do not replace MySQL integration tests, BNB Smart Chain testnet exercises, SMTP tests, or a full reconciliation rehearsal before production.

## API security and request-abuse controls

The HTTP process applies request limits before parsing the request body. The default global IP limit is 180 requests per 60 seconds. Stricter per-route IP windows also cover APK/privacy downloads, version checks, sign-in, registration, stock/recharge reads (including the one-second cached recharge-availability polling endpoint), payout-address changes, seller actions, transaction history, P2P transfers, disbursement status, account deletion, credential updates, recovery, contact messages and administrative actions. Matching is case-insensitive and ignores trailing slashes to avoid trivial route-limit bypasses. `TRUST_PROXY_HOPS` must match the actual reverse-proxy topology; it defaults to `0` so untrusted `X-Forwarded-For` headers are not accepted as client identity. If TLS terminates at a trusted reverse proxy, configure the appropriate hop count. `FORCE_HTTPS=true` additionally requires `PUBLIC_HTTPS_ORIGIN` and redirects requests to that canonical HTTPS origin.

Normal JSON and URL-encoded request bodies are limited to 256kb. Registration has a separate `SIGNUP_BODY_LIMIT` (10mb by default, hard-capped at 10mb) because identity images are sent with the signup request; each provided base64 image is validated and limited to 3mb after decoding. Signup fields are checked before Argon2 work, and username collision retries are capped at ten attempts.

### Per-account 24-hour security quotas

The following limits use rolling 24-hour windows, persisted in MySQL and serialized with account-specific row locks:

- Password change: up to three failed attempts and one successful change. The successful change remains available even after three failed attempts; a fourth failed attempt returns `{ "auth": "limit reached" }`.
- Seed change: the same three-failed / one-successful rule.
- Account recovery: two requests total. A request is counted before seed verification, so incorrect seeds also consume one of the two requests. A third request returns `{ "auth": "limit reached" }`.

The `account_security_events` table stores the quota events. Events older than eight days are removed by the regular cleanup job; the decision itself only counts the preceding 24 hours. The account action lock rows serialize concurrent requests so simultaneous submissions cannot exceed the quotas.

### Other per-account limits

Authenticated request limits also protect contact messages, stock reads, recharge information/status and payout-address changes, seller activation/cancellation, transaction history, P2P transfers, disbursement status and account deletion. The frequent aggregate recharge-availability poll uses a short shared server cache and an IP-level route limit rather than an Argon2 password re-hash for every poll; its session token is checked; account eligibility remains enforced by the account-specific endpoints and the actual recharge-credit transaction. These are additional abuse controls and do not alter the financial calculations or the business eligibility checks. Their counters are stored in `account_api_rate_limits` and are removed after their fixed-window retention period.

### Database and resource protections

`multipleStatements` is disabled in the MySQL pool. User-provided SQL values remain parameterized; SQL identifiers used in generated statements come only from internal allowlists. The new security-limit queries use MySQL prepared execution. The pool defaults to 20 connections and a queue of 100 waiting requests, configurable through `DB_CONNECTION_LIMIT` and `DB_QUEUE_LIMIT`.

Argon2id concurrency remains bounded. Its waiting queue defaults to 20 jobs and expires a queued request after 15 seconds. Queue saturation returns a temporary-unavailability response instead of allowing an unbounded backlog.

Email delivery is bounded by an in-process queue: at most 30 messages initiated per hour, 50 waiting messages, two concurrent SMTP sends and two attempts per message by default. Per-account and per-IP endpoint limits are applied before sending. This mail queue is intentionally in-memory; pending messages are not durable across a process restart.

### Transaction history API

`POST /app/transactions-history` now enforces a maximum of 30 rolling days (the stored UTC activity timestamp is accurate to one second; the cutoff is rounded upward so no older second is included), regardless of a larger requested `days` value. It returns at most 100 rows per request (50 by default). The existing `trans` response property is preserved. When another page may exist, `next_before_id` contains the last returned activity ID; send it as `before_id` on the next request. The cursor prevents deep `OFFSET` scans and preserves descending ID order.

The IP limiter is process-local. For a deployment with multiple Node.js instances, enforce the same or stricter IP limits at the shared reverse proxy/API gateway. Per-account quotas and the additional per-account request counters are MySQL-backed and therefore shared across instances.


## Shared treasury address and manual recharge suspension

`POST /app/user-last-stock` is the only application endpoint that returns the shared OneX treasury address as `deposit_addr`. When recharge is unavailable (global disbursement, manual suspension, disabled BSC payment provider or insufficient capacity for the minimum net recharge), the endpoint returns `deposit_addr: null`. No per-user deposit address is generated or stored. `POST /app/recharge` returns only the BEP-20 payment configuration and recharge availability; `POST /app/recharge/status` remains the status endpoint for the user's incoming payment session.

The public BSC wallet address is mandatory at `/app/signup`, stored in `auths.wallet_address` and checked for EVM format, checksum and uniqueness. OneX does not verify wallet ownership. The address is fixed for account use; the permanent `bsc_wallet_address_registry` prevents reuse after account deletion. Incoming deposits are identified using the BEP-20 event sender (`Transfer.from`), so a user must send directly from the registered address. Transfers from exchange omnibus wallets, pooled wallets or relayers may have an unregistered sender and will be held in `bsc_unknown_incoming_transfers` for administrative resolution.

Administrators can manage a critical manual recharge suspension through `POST /admin/recharge/control` using the configured admin password and PIN:

- `{ "action": "suspend", "reason": "..." }` hides addresses and stops automatic recharge credits. A reason of 5 to 1000 characters is required.
- `{ "action": "resume", "reason": "..." }` restores normal recharge availability, subject to global-disbursement and account-capacity rules. A reason is required and recorded.
- `{ "action": "status" }` reads the current control state.

The control is persisted in `recharge_service_control`; changes are recorded in `recharge_service_control_events`. The admin command and recharge intake/credit paths serialize on `system_locks.common_state`. Incoming BSC-USD transfers during manual suspension are recorded directly from the shared treasury event stream, but their batches are held as `pending_support` with reason `manual_recharge_suspended`; they are not credited automatically. Automatic credits are also held if the payment provider is unavailable. Reviewed administrative batch-credit operations have an explicit override; public recharge flows do not. The reviewed admin credit/refund workflow remains available for manual resolution.
