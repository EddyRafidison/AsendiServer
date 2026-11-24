# OneXServer BSC RPC routing implementation

Date: 2026-11-23

## 1. Endpoint responsibilities

| Purpose | Environment variable | Example | Used by |
|---|---|---|---|
| Outgoing BSC operations | `BSC_RPC_URL` | fictitious Chainstack endpoint in `.env.example` | Disbursement worker, seller/refund payouts, treasury worker, outgoing transaction submission and BNB/USD oracle reads |
| Incoming HTTP scanner primary | `BSC_INCOMING_RPC_URL` | `https://bsc-rpc.publicnode.com` | Incoming `eth_getLogs`, finalized-head, receipt and canonical-block reads |
| Incoming HTTP scanner fallback | `BSC_INCOMING_RPC_FALLBACK_URL` | same fictitious Chainstack endpoint as `BSC_RPC_URL` | Used only when the incoming primary has a transient transport/rate-limit/server/capacity failure or fails chain/contract validation |
| Incoming log notifications | `BSC_INCOMING_WS_RPC_URL` | `wss://bsc-rpc.publicnode.com` | Ethers v6 `EventFilter` subscription; notifications wake the HTTP scanner only |
| Incoming fallback cooldown | `BSC_INCOMING_RPC_COOLDOWN_MS` | `30000` | Temporarily opens the failing provider's circuit |

The Chainstack endpoint shown in `.env.example` is deliberately fictional. Replace the `nd-000-000-000` host and `REPLACE_WITH_CHAINSTACK_NODE_TOKEN` path with the real HTTPS endpoint supplied by the Chainstack project before enabling payments. Never commit a real endpoint containing a credential.

## 2. Incoming scan behavior

1. PublicNode is the normal HTTP and WebSocket source for incoming BSC-USD transfers.
2. The WebSocket subscription filters the approved token contract and the treasury `to` topic. Topic index 1 (sender) remains a wildcard; topic index 2 is the treasury address.
3. A WebSocket log is only a wake-up hint. It is not credited, persisted as financial evidence, or used to move the MySQL cursor by itself.
4. The HTTP scanner resumes from the durable MySQL cursor, fetches finalized logs in bounded block ranges, validates each matching positive transfer against its transaction receipt and canonical block, and commits event handling before advancing the cursor.
5. The HTTP polling interval defaults to 30 seconds when idle. A matching WebSocket notification may wake a scan sooner, but WebSocket-triggered scans are throttled to at least 10 seconds apart by default. Multiple notifications during a running scan are coalesced.
6. The WebSocket hint is reconnected after errors/closed sockets with bounded exponential backoff (5, 10, 20, 40, then 60 seconds). Network detection and subscription setup each have a 15-second timeout; a 15-second health check detects a closing/closed socket. HTTP polling and cursor recovery continue if WebSocket is unavailable.
7. `eth_getLogs` remains the recovery source of truth. A WebSocket disconnect cannot permanently lose events because the next HTTP scan catches up from the stored cursor.

## 3. Conditional HTTP fallback

- `BSC_INCOMING_RPC_URL` is tried first.
- The scanner does not query PublicNode and Chainstack in parallel during ordinary scanning.
- A configured fallback is tried after network timeouts, connection errors, HTTP 408/425/429/5xx, known RPC rate/capacity errors, or an endpoint validation failure (wrong chain, missing approved token contract, wrong token decimals, or authentication/configuration failure).
- The failing endpoint circuit is opened for `BSC_INCOMING_RPC_COOLDOWN_MS` (default 30 seconds) and is then eligible for a probe again.
- Deterministic request errors (for example, an unsupported optional `finalized` block tag or invalid method parameters) do not open the circuit and do not move routine traffic to the paid fallback. The caller may use the existing confirmation-count fallback when the `finalized` tag is unsupported.
- Reconciliation deliberately queries two distinct incoming HTTPS endpoints for independent evidence. It is an administrative recovery operation, not normal polling.

## 4. Financial invariants preserved

This RPC routing change does not introduce an amount filter and does not discard low-value incoming transfers. Every positive, finalized incoming `Transfer` log matching the treasury continues into the existing financial processing pipeline. The existing BSC-USD reception limits (70–140 BSC-USD per user over a rolling seven-day period), 60-minute grouping window, separate 100 BSC-USD first-credit-tranche cap, remainder handling, registered-wallet checks, account-capacity checks, `tfees`, reserve priority and administrative hold rules remain the responsibility of the financial deposit pipeline.

No SQL migration or deposit/disbursement rule change is introduced by this routing update.

## 5. Why no automatic outgoing RPC fallback is enabled

Outgoing operations continue to use `BSC_RPC_URL` (Chainstack). This release intentionally does not add a blind second-provider retry after an outgoing transaction broadcast timeout. A timeout can mean that a signed transaction was accepted by the network but the response was lost. Before any second-endpoint broadcast, OneXServer must reconcile the transaction hash, raw signed transaction, nonce and receipt state. Retrying an outgoing operation as a new transaction without that reconciliation could create duplicate or conflicting transfers.

## 6. Example configuration

The executable reference values are in `.env.example`:

```env
BSC_RPC_URL=https://nd-000-000-000.p2pify.com/REPLACE_WITH_CHAINSTACK_NODE_TOKEN
BSC_INCOMING_RPC_URL=https://bsc-rpc.publicnode.com
BSC_INCOMING_WS_RPC_URL=wss://bsc-rpc.publicnode.com
BSC_INCOMING_RPC_FALLBACK_URL=https://nd-000-000-000.p2pify.com/REPLACE_WITH_CHAINSTACK_NODE_TOKEN
BSC_INCOMING_RPC_COOLDOWN_MS=30000

USDT_PAYMENT_POLL_MS=30000
USDT_CURSOR_HASH_CHECK_INTERVAL_MS=60000
USDT_WS_MIN_SCAN_INTERVAL_MS=10000
```

These are examples, not live credentials. The fictitious Chainstack URL must be replaced. The PublicNode BSC mainnet HTTPS endpoint is published as `https://bsc-rpc.publicnode.com`; verify the WS endpoint availability with the provider before production deployment.

## 7. Documentation consulted

- PublicNode BNB Smart Chain RPC gateway: https://bsc.publicnode.com/
- BNB Chain JSON-RPC endpoint guidance (including mainnet chain ID 56, public endpoint limits and recommendation to use WebSockets for frequent log delivery): https://docs.bnbchain.org/bnb-smart-chain/developers/json_rpc/json-rpc-endpoint/
- Ethers v6 provider events and `EventFilter` / `TopicFilter` semantics: https://docs.ethers.org/v6/api/providers/
- Ethers v6 JSON-RPC transport and `WebSocketProvider`: https://docs.ethers.org/v6/api/providers/jsonrpc/
- Chainstack BNB Smart Chain deployment documentation: https://chainstack.com/build-better-with-bnb-smart-chain/
