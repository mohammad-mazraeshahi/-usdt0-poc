// ─────────────────────────────────────────────
//  Borsh encoding for OFT instruction params
//  (manual Anchor borsh — no IDL needed)
// ─────────────────────────────────────────────
import crypto from 'crypto';

// ── Discriminators ───────────────────────────
function disc(name) {
  return crypto.createHash('sha256').update(`global:${name}`).digest().slice(0, 8);
}
export const DISCRIMINATORS = {
  send:       disc('send'),
  quote_send: disc('quote_send'),
  quote_oft:  disc('quote_oft'),
};

// ── Primitive writers ────────────────────────
function writeU8(val)  { const b = Buffer.alloc(1); b.writeUInt8(val);         return b; }
function writeU16(val) { const b = Buffer.alloc(2); b.writeUInt16LE(val);      return b; }
function writeU32(val) { const b = Buffer.alloc(4); b.writeUInt32LE(val);      return b; }
function writeU64(val) {
  const b = Buffer.alloc(8);
  const big = BigInt(val);
  b.writeBigUInt64LE(big);
  return b;
}
function writeBytes(data) {
  // Vec<u8>: 4-byte LE length prefix + data
  return Buffer.concat([writeU32(data.length), Buffer.from(data)]);
}
function writeOptionBytes(data) {
  // Option<Vec<u8>>: 1 byte (0=None, 1=Some) + optional Vec<u8>
  if (data === null || data === undefined) return writeU8(0);
  return Buffer.concat([writeU8(1), writeBytes(data)]);
}

// ── SendParams encoder ───────────────────────
/**
 * Encode SendParams for the OFT `send` instruction.
 * @param {object} p
 * @param {number}        p.dstEid
 * @param {Buffer|Uint8Array} p.to        32-byte recipient
 * @param {bigint|number} p.amountLd      token amount (6 decimals)
 * @param {bigint|number} p.minAmountLd
 * @param {Buffer}        p.extraOptions  (usually empty Buffer)
 * @param {Buffer|null}   p.composeMsg    null for legacy, Buffer for adaptive
 * @param {bigint|number} p.nativeFee     SOL fee in lamports (from quoteSend)
 * @param {bigint|number} p.lzTokenFee    usually 0
 */
export function encodeSendParams(p) {
  return Buffer.concat([
    DISCRIMINATORS.send,
    writeU32(p.dstEid),
    Buffer.from(p.to),            // exactly 32 bytes
    writeU64(p.amountLd),
    writeU64(p.minAmountLd),
    writeBytes(p.extraOptions ?? Buffer.alloc(0)),
    writeOptionBytes(p.composeMsg),
    writeU64(p.nativeFee),
    writeU64(p.lzTokenFee ?? 0),
  ]);
}

// ── QuoteSendParams encoder ──────────────────
export function encodeQuoteSendParams(p) {
  return Buffer.concat([
    DISCRIMINATORS.quote_send,
    writeU32(p.dstEid),
    Buffer.from(p.to),
    writeU64(p.amountLd),
    writeU64(p.minAmountLd),
    writeBytes(p.extraOptions ?? Buffer.alloc(0)),
    writeOptionBytes(p.composeMsg),
    writeU8(p.payInLzToken ? 1 : 0),
  ]);
}

// ── QuoteOFTParams encoder ───────────────────
export function encodeQuoteOftParams(p) {
  return Buffer.concat([
    DISCRIMINATORS.quote_oft,
    writeU32(p.dstEid),
    Buffer.from(p.to),
    writeU64(p.amountLd),
    writeU64(p.minAmountLd),
    writeBytes(p.extraOptions ?? Buffer.alloc(0)),
    writeOptionBytes(p.composeMsg),
    writeU8(p.payInLzToken ? 1 : 0),
  ]);
}

// ── Address helpers ──────────────────────────
/** Pad an EVM address (0x...) to 32 bytes (left-padded zeros) */
export function evmAddressTo32(addr) {
  const hex = addr.replace(/^0x/, '').toLowerCase().padStart(64, '0');
  return Buffer.from(hex, 'hex');
}

/** Parse a native fee from quoteSend response (first 8 bytes LE u64) */
export function parseQuoteSendResponse(returnData) {
  // MessagingFee: { native_fee: u64, lz_token_fee: u64 }
  const nativeFee = returnData.readBigUInt64LE(0);
  const lzFee     = returnData.readBigUInt64LE(8);
  return { nativeFee, lzFee };
}

// ── Compose message for adaptive chains ──────
/**
 * Encode the compose message payload for a legacy→adaptive hop.
 * This is the payload that gets executed on Arbitrum to forward to the final chain.
 *
 * USDT0 Arbitrum OFT compose receiver expects ABI-encoded:
 *   (uint32 dstEid, bytes32 to, uint256 minAmountLD, bytes extraOptions)
 *
 * @param {number} finalEid      - destination chain EID (e.g. Berachain 30362)
 * @param {string} finalReceiver - 0x address on final chain
 * @param {bigint} minAmountLd   - min tokens on final chain
 * @param {Buffer} extraOptions  - LZ options for final hop (usually empty)
 */
export function encodeComposeMsg(finalEid, finalReceiver, minAmountLd, extraOptions = Buffer.alloc(0)) {
  // ABI encode: (uint32, bytes32, uint256, bytes)
  // We use manual ABI encoding (no ethers dependency needed here)
  // Slot layout (each 32 bytes):
  //  [0] uint32 dstEid (left-padded)
  //  [1] bytes32 to
  //  [2] uint256 minAmountLD
  //  [3] offset to `bytes` (= 4 * 32 = 128)
  //  [4] bytes length
  //  [5+] bytes data (padded to 32)

  const eidBuf = Buffer.alloc(32);
  eidBuf.writeUInt32BE(finalEid, 28);

  const toBuf = evmAddressTo32(finalReceiver);

  const minAmtBuf = Buffer.alloc(32);
  minAmtBuf.writeBigUInt64BE(minAmountLd, 24);

  const offsetBuf = Buffer.alloc(32);
  offsetBuf.writeUInt32BE(128, 28);  // offset = 4 slots * 32

  const lenBuf = Buffer.alloc(32);
  lenBuf.writeUInt32BE(extraOptions.length, 28);

  // Pad extraOptions to 32-byte boundary
  const padded = Buffer.alloc(Math.ceil(extraOptions.length / 32) * 32);
  extraOptions.copy(padded);

  return Buffer.concat([eidBuf, toBuf, minAmtBuf, offsetBuf, lenBuf, padded]);
}

// ── LZ V2 options encoding ───────────────────
/**
 * Encode a Type 3 options buffer containing a single lzCompose option.
 *
 * LZ V2 Type 3 format:
 *   [0x00, 0x03]                          ← type-3 header (2 bytes)
 *   [workerID: u8]                        ← 1 = Executor
 *   [optionLen: u16 BE]                   ← length of option data (bytes after this field)
 *   [optionType: u8]                      ← 3 = lzCompose
 *   [index: u16 BE]                       ← compose call index (0 = first)
 *   [gasLimit: u128 BE (16 bytes)]        ← gas for compose execution on destination
 *   [value: u128 BE (16 bytes)]           ← native drop value (usually 0)
 *
 * When combined with enforced options (which already have lzReceive), the executor
 * will also trigger the compose call after lzReceive completes.
 *
 * @param {number}  composeIndex  - compose call index, usually 0
 * @param {bigint}  gasLimit      - gas for compose on destination chain
 * @param {bigint}  [value=0n]    - native token value to forward with compose
 */
export function encodeLzComposeOption(composeIndex = 0, gasLimit = 500_000n, value = 0n) {
  // Option data: [type:1][index:2][gasLimit:16][value:16] = 35 bytes
  const optionData = Buffer.alloc(35);
  optionData[0] = 3;                              // OPTION_TYPE_LZCOMPOSE
  optionData.writeUInt16BE(composeIndex, 1);       // compose index
  optionData.writeBigUInt64BE(0n, 3);             // gasLimit high 64 bits (u128)
  optionData.writeBigUInt64BE(gasLimit, 11);       // gasLimit low 64 bits
  optionData.writeBigUInt64BE(0n, 19);            // value high 64 bits
  optionData.writeBigUInt64BE(value, 27);          // value low 64 bits

  // Worker block: [workerID=1][optionLen:u16 BE][optionData]
  const block = Buffer.alloc(3);
  block[0] = 1;                                   // Executor worker ID
  block.writeUInt16BE(optionData.length, 1);       // = 35 = 0x23

  // Type 3 prefix + worker block + option data
  return Buffer.concat([
    Buffer.from([0x00, 0x03]),  // Type 3 header
    block,
    optionData,
  ]);
}
