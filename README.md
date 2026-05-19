# USDT0 OFT — Solana Send POC

A minimal, dependency-light implementation for sending USDT0 from Solana to any supported chain via LayerZero V2. No official SDK required — all account derivation and Borsh encoding is done from scratch against the deployed bytecode.

**Verified on mainnet:**
- Solana → Ethereum (legacy direct): tx [`5xjupS8ux...`](https://solscan.io/tx/5xjupS8uxTQMNNvxw8ic7Tf5DUB6ks5jrdcY3iEHH4ughXa81euuRBpWQBL9iMvS41LjKrS81rDoppVkPCCYfcxn)
- Solana → Arbitrum → Berachain (adaptive 2-hop): tx [`gpn4JAPAG...`](https://solscan.io/tx/gpn4JAPAG11Ryae6KoiMPGMECmsQrALYa7QQb5JbQW6JtY5ecP3TTfxZReVDdH3sqXxs4JWMTfxTQofTQEaLHXL)

---

## Architecture

USDT0 on Solana is an **OFT Adapter** — it holds real USDT in escrow and mints/burns on the receiving end. The program is deployed at:

```
Fuww9mfc8ntAwxPUzFia7VJFAdvLppyZwhPJoXySZXf7
```

Source: [`LayerZero-Labs/usdt-native-mesh`](https://github.com/LayerZero-Labs/usdt-native-mesh)

### Send flow

```
Wallet
  │
  ▼
OFT Program (send)
  │  ├─ transfers USDT from sender ATA → token escrow
  │  ├─ decrements Credits[dstEid]
  │  └─ emits OFTSent event
  │
  ▼
LZ Endpoint (send CPI)
  │  └─ increments outbound nonce
  │
  ▼
ULN (Send Library CPI)
  │  └─ quotes executor + DVN fees, records packet
  │
  ▼
Executor + DVNs
     └─ deliver packet to destination chain
```

### Adaptive routing (2-hop)

Berachain, TON, and other "adaptive" chains can't receive directly from Solana. The path is:

```
Solana → Arbitrum OFT (leg 1, with compose msg)
                  └─► Arbitrum → final chain (leg 2, triggered by compose)
```

The compose message is ABI-encoded: `(uint32 finalEid, bytes32 to, uint256 minAmountLD, bytes extraOptions)`.

---

## Programs & Addresses

| Name | Address |
|------|---------|
| USDT0 OFT Program | `Fuww9mfc8ntAwxPUzFia7VJFAdvLppyZwhPJoXySZXf7` |
| LZ Endpoint | `76y77prsiCMvXMjuoZ5VRrhG5qYBrUMYTE5WgHqgjEn6` |
| ULN (Send Library) | `7a4WjyR8VZ7yZz5XJAKm39BUGn5iT9CKcv2pmG9tdXVH` |
| Executor | `6doghB248px58JSSwG4qejQ46kFMW4AMj7vzJnWZHNZn` |
| DVN LZ (price oracle) | `8ahPGPjEbpgGaZx2NV1iG5Shj7TDwvsjkEDcGWjt94TP` |
| DVN 2 | `HtEYV4xB4wvsj5fgTkcfuChYpvGYzgzwvNhgDZQNh7wW` |
| DVN 3 | `3T7waVnx1W54ZA7XuRmXngoua4hEkRXciNL8stBJAUR4` |
| USDT0 Mint | `Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB` |
| OFT Store PDA | `HyXJcgYpURfDhgzuyRL7zxP4FhLg7LZQMeDrR4MXZcMN` |
| Credits PDA | `6trV82jqtcqrsMd5ZXKvR6QzLX6bHstBK4wZFx1qrffC` |
| Token Escrow | `F1YkdxaiLA1eJt12y3uMAQef48Td3zdJfYhzjphma8hG` |
| ALT | `6zcTrmdkiQp6dZHYUxVr6A2XVDSYi44X1rcPtvwNcrXi` |

---

## Supported Chains

| Chain | EID | USDT0 OFT Address | Route |
|-------|-----|-------------------|-------|
| Ethereum | 30101 | `0x6c96dE32CEa08842dcc4058c14d3aaAD7Fa41ef` | Direct |
| Arbitrum | 30110 | `0x77652d5Aba086137b595875263Fc200182919B92` | Direct |
| Celo | 30125 | — | Direct |
| Tron | 30420 | — | Direct |
| TON | 30343 | — | Direct |
| Berachain | 30362 | `0x779B8B8B98E39E15D937A4E6B16dDc3e07E21E29` | Via Arbitrum |

---

## Setup

```bash
npm install

# Fund a wallet with SOL and USDT0 (mainnet)
# Place the keypair JSON at: test-wallet.json
# Format: [byte0, byte1, ..., byte63]  (64-byte secret key)
```

### Minimum balances
- **SOL**: ~0.05 SOL (covers LZ fee ~0.007 SOL + rent + priority fee)
- **USDT0**: any amount ≥ send amount (default: 0.001 USDT = 1000 micro-USDT)

---

## Usage

### Diagnose / verify setup
```bash
npm run diagnose
```
Outputs all derived PDAs, verifies against known on-chain values, fetches an example tx account map, checks wallet balances, and runs a `quoteSend` simulation.

### Send to a legacy chain (direct)
```bash
npm run send-legacy
```
Default config: `0.001 USDT → Ethereum (EID 30101)`.

Edit `scripts/send-legacy.js` to change:
```js
const DST_EID   = EID.ETH;          // destination chain
const DST_ADDR  = '0xYourAddress';  // recipient on destination
const AMOUNT_LD = 1000n;            // amount in micro-USDT (6 decimals)
```

### Send to an adaptive chain (2-hop)
```bash
npm run send-adaptive
```
Default config: `0.001 USDT → Berachain via Arbitrum`.

Edit `scripts/send-adaptive.js` to change:
```js
const LEG1_DST_EID = EID.ARBITRUM;  // relay chain (must be an LZ v2 chain)
const FINAL_EID    = EID.BERACHAIN; // final destination
const DST_ADDR     = '0xYourAddress';
```

---

## Code Structure

```
src/
  constants.js   — program IDs, EIDs, PDA seeds, EVM OFT addresses
  pda.js         — all PDA derivation functions (OFT, endpoint, ULN, executor, DVNs)
  accounts.js    — buildSendAccounts() — builds the 40-account list for send
  borsh.js       — manual Borsh/ABI encoding (SendParams, QuoteSendParams, compose msg)
  quote.js       — quoteSend() — simulates fee via quote_send view instruction

scripts/
  diagnose.js      — full system diagnostic + quoteSend test
  send-legacy.js   — send to ETH/ARB/CELO/TRON/TON (direct)
  send-adaptive.js — send to Berachain via Arbitrum (compose 2-hop)
```

---

## Account Structures (reverse-engineered)

### `send` instruction — 40 accounts

```
Core (from OFT Send struct):
  [0]  signer / payer           — writable, signer
  [1]  peer PDA                 — readonly  PDA(["Peer", dstEid_BE], OFT_PROGRAM)
  [2]  oft_store                — writable  PDA(["OFT"], OFT_PROGRAM)
  [3]  credits                  — writable  PDA(["Credits"], OFT_PROGRAM)
  [4]  token_source (sender ATA)— writable
  [5]  token_escrow             — writable  (from oft_store.token_escrow)
  [6]  token_mint               — readonly  USDT0 = Es9vMFrz...
  [7]  token_program            — readonly  TokenkegQ...

Caller-added (emit_cpi pattern):
  [8]  oft_event_authority      — readonly  PDA(["__event_authority"], OFT_PROGRAM)
  [9]  OFT program (self-ref)   — readonly

Endpoint CPI block (remaining[0-9]):
  [10] LZ Endpoint program      — readonly  (construct_context: accounts[0] == program)
  [11] oft_store (oapp)         — writable  (same as [2], passed again as sender)
  [12] SEND_LIB program         — readonly
  [13] sendLibraryConfig        — readonly  PDA(["SendLibraryConfig", oapp, dstEid], ENDPOINT)
  [14] defaultSendLibConfig     — readonly  PDA(["SendLibraryConfig", dstEid], ENDPOINT)
  [15] messageLibInfo           — readonly  PDA(["MessageLib", ulnSetting], ENDPOINT)
  [16] endpointSettings         — readonly  PDA(["Endpoint"], ENDPOINT)
  [17] nonce                    — writable  PDA(["Nonce", oapp, dstEid, peer32], ENDPOINT)
  [18] endpoint event_authority — readonly  PDA(["__event_authority"], ENDPOINT)
  [19] LZ Endpoint (emit_cpi)   — readonly

ULN CPI block (remaining[10-17]):
  [20] ULN Setting PDA          — readonly  PDA(["MessageLib"], SEND_LIB)
  [21] ulnSendConfig            — readonly  PDA(["SendConfig", dstEid, oapp], SEND_LIB)
  [22] ulnDefaultSendConfig     — readonly  PDA(["SendConfig", dstEid], SEND_LIB)
  [23] payer (fee payer)        — writable  (same as [0])
  [24] SEND_LIB (emit_cpi)      — readonly
  [25] system_program           — readonly
  [26] ULN event_authority      — readonly  PDA(["__event_authority"], SEND_LIB)
  [27] SEND_LIB (emit_cpi 2)    — readonly

Worker block (remaining[18-29]):
  [28] Executor program         — readonly
  [29] ExecutorConfig           — writable  PDA(["ExecutorConfig"], EXECUTOR)
  [30] DVN_LZ program           — readonly  (price oracle)
  [31] DVN_LZ PriceFeed PDA     — readonly  PDA(["PriceFeed"], DVN_LZ)
  [32] DVN_2 program            — readonly
  [33] DVN_2 DvnConfig          — writable  PDA(["DvnConfig"], DVN_2)
  [34] DVN_LZ program (repeat)  — readonly
  [35] DVN_LZ PriceFeed (repeat)— readonly
  [36] DVN_3 program            — readonly
  [37] DVN_3 DvnConfig          — writable  PDA(["DvnConfig"], DVN_3)
  [38] DVN_LZ program (repeat)  — readonly
  [39] DVN_LZ PriceFeed (repeat)— readonly
```

### `quote_send` instruction — 25 accounts (all read-only)

USDT0's `quote_send` is a view function — it simulates the fee without moving tokens. Its account structure differs from `send`:

```
OFT named (from usdt-native-mesh QuoteSend struct):
  [0]  oft_store                — PDA(["OFT"], OFT_PROGRAM)
  [1]  credits                  — PDA(["Credits"], OFT_PROGRAM)
  [2]  peer                     — PDA(["Peer", dstEid_BE], OFT_PROGRAM)

Endpoint Quote CPI (remaining, via construct_context — accounts[0] must == program):
  [3]  LZ Endpoint program      ← construct_context program-ID check
  [4]  SEND_LIB program
  [5]  sendLibraryConfig
  [6]  defaultSendLibConfig
  [7]  messageLibInfo
  [8]  endpointSettings
  [9]  nonce

ULN Quote CPI (via CpiContext::new_with_signer — no program prefix):
  [10] ULN Setting PDA
  [11] ulnSendConfig
  [12] ulnDefaultSendConfig

Worker accounts (executor + 2 DVNs, 4 accounts each):
  [13] Executor program
  [14] ExecutorConfig
  [15] DVN_LZ program
  [16] DVN_LZ PriceFeed PDA
  [17] DVN_2 program
  [18] DVN_2 DvnConfig
  [19] DVN_LZ program
  [20] DVN_LZ PriceFeed PDA
  [21] DVN_3 program
  [22] DVN_3 DvnConfig
  [23] DVN_LZ program
  [24] DVN_LZ PriceFeed PDA
```

> **Key difference from generic OFT:** USDT0 adds a `credits` account (rate limiter per destination chain). The generic `devtools` OFT example has only `(oft_store, peer, token_mint)`.

> **Key gotcha — `construct_context`:** The `cpi_helper::CpiContext` derive macro checks `accounts[0].key() == program_id`. So the endpoint program must appear as the first element of `remaining_accounts` before the 6 named `Quote` accounts.

---

## PDA Seeds Reference

| Account | Seeds | Program |
|---------|-------|---------|
| OFT Store | `["OFT"]` | OFT_PROGRAM |
| Credits | `["Credits"]` | OFT_PROGRAM |
| Peer | `["Peer", dstEid_BE_u32]` | OFT_PROGRAM |
| OFT Event Auth | `["__event_authority"]` | OFT_PROGRAM |
| Endpoint Settings | `["Endpoint"]` | ENDPOINT |
| Send Library Config | `["SendLibraryConfig", oapp_bytes, dstEid_BE_u32]` | ENDPOINT |
| Default Send Lib Config | `["SendLibraryConfig", dstEid_BE_u32]` | ENDPOINT |
| MessageLib Info | `["MessageLib", ulnSetting_bytes]` | ENDPOINT |
| Nonce | `["Nonce", sender_bytes, dstEid_BE_u32, receiver_bytes32]` | ENDPOINT |
| Endpoint Event Auth | `["__event_authority"]` | ENDPOINT |
| ULN Setting | `["MessageLib"]` | SEND_LIB |
| ULN Send Config | `["SendConfig", dstEid_BE_u32, oapp_bytes]` | SEND_LIB |
| ULN Default Config | `["SendConfig", dstEid_BE_u32]` | SEND_LIB |
| Send Lib Event Auth | `["__event_authority"]` | SEND_LIB |
| Executor Config | `["ExecutorConfig"]` | EXECUTOR |
| DVN LZ Price Feed | `["PriceFeed"]` | DVN_LZ |
| DVN 2 Config | `["DvnConfig"]` | DVN_2 |
| DVN 3 Config | `["DvnConfig"]` | DVN_3 |

---

## Instruction Encoding

### SendParams (Borsh)
```
discriminator  [u8; 8]   sha256("global:send")[..8]
dst_eid        u32 LE
to             [u8; 32]  EVM address left-padded to 32 bytes
amount_ld      u64 LE    token amount (6 decimals)
min_amount_ld  u64 LE
extra_options  Vec<u8>   [u32 LE length prefix] + bytes
compose_msg    Option<Vec<u8>>  [u8 flag 0/1] + optional Vec<u8>
native_fee     u64 LE    lamports (from quoteSend + 10% buffer)
lz_token_fee   u64 LE    usually 0
```

### QuoteSendParams (Borsh)
Same as SendParams but replaces `native_fee` + `lz_token_fee` with:
```
pay_in_lz_token  u8  (bool, usually 0)
```

### Compose message (ABI-encoded, for adaptive sends)
```
slot 0  uint32  finalEid         (left-padded to 32 bytes)
slot 1  bytes32 to               (recipient on final chain)
slot 2  uint256 minAmountLD
slot 3  uint256 offset           (= 4 * 32 = 128, points to bytes data)
slot 4  uint256 bytes_length
slot 5+ bytes   extraOptions     (padded to 32-byte boundary)
```

---

## Fee Reference (mainnet, May 2026)

| Route | LZ Fee |
|-------|--------|
| Solana → Ethereum | ~0.0072 SOL |
| Solana → Arbitrum | ~0.0009 SOL |
| Solana → Arbitrum → Berachain | ~0.0009 SOL |

Fees are paid in native SOL. The `quoteSend` simulation returns the exact fee before each send.

---

## Notes

- The ALT (`6zcTrmd...`) is stored in `OFTStore.alt` and must be loaded and passed to `compileToV0Message` — without it the 40-account transaction exceeds Solana's 1232-byte raw size limit.
- The `credits` account tracks how many tokens can still be sent to each destination chain (circuit breaker). The send fails with `InsufficientCredits` if the chain's credit balance is 0. Credits are replenished by incoming receives from that chain.
- All accounts in `quote_send` must be **read-only** — the endpoint enforces this and rejects writable accounts with `WritableAccountNotAllowed`.
