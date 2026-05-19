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
 *
 * The USDT0 Adaptive Bridge on Arbitrum (0x759BA420...) receives this as its
 * lzCompose `_message` param. It decodes it as a full SendParam struct and
 * uses the NEW Arb OFT to execute leg 2 to the native USDT0 OFT chain.
 *
 * Format: abi.encode(SendParam sendParam)
 *   SendParam = (uint32 dstEid, bytes32 to, uint256 amountLD,
 *                uint256 minAmountLD, bytes extraOptions, bytes composeMsg, bytes oftCmd)
 *
 * Since SendParam contains dynamic fields (bytes), abi.encode() prepends a 32-byte
 * offset (0x20) before the tuple, per Solidity ABI spec.
 *
 * Verified against on-chain example tx JUjUi5NiajNJCqqwQTA75R1Mz14BmBUJTwXK77HXyZ2...
 *
 * @param {number} finalEid      - destination chain EID (e.g. Berachain 30362)
 * @param {string} finalReceiver - 0x address on final chain
 * @param {bigint} amountLd      - token amount (same as sent, 6 decimals)
 * @param {bigint} minAmountLd   - min tokens on final chain
 * @param {Buffer} extraOptions  - LZ options for final hop (e.g. native drop)
 */
export function encodeComposeMsg(finalEid, finalReceiver, amountLd, minAmountLd, extraOptions = Buffer.alloc(0)) {
  function word32(n) {
    const b = Buffer.alloc(32);
    const big = BigInt(n);
    // write as big-endian u256 (right-justified)
    b.writeBigUInt64BE(big >> 64n, 16);
    b.writeBigUInt64BE(big & 0xffffffffffffffffn, 24);
    return b;
  }
  function word32u32(n) {
    const b = Buffer.alloc(32);
    b.writeUInt32BE(n, 28);
    return b;
  }

  const toBuf = evmAddressTo32(finalReceiver);  // bytes32 to

  // ABI head: 7 fields (4 static + 3 dynamic offsets), relative to tuple start
  const HEAD_SIZE = 7 * 32;  // 224 bytes
  const extraOptsPaddedLen = Math.ceil(extraOptions.length / 32) * 32;

  // Offsets are relative to the START OF THE TUPLE (not including the outer 0x20 word)
  const extraOptsOffset  = HEAD_SIZE;                                    // 224
  const composeMsgOffset = HEAD_SIZE + 32 + extraOptsPaddedLen;          // 224 + 32 + ceil(extraLen/32)*32
  const oftCmdOffset     = composeMsgOffset + 32;                        // composeMsg.length=0, so +32

  // Outer ABI offset word (because the struct is dynamic)
  const outerOffset = word32u32(32);  // 0x20

  // Static fields
  const dstEidWord   = word32u32(finalEid);
  const amountWord   = word32(amountLd);
  const minAmtWord   = word32(minAmountLd);

  // Offset words
  const extraOptsOffsetWord  = word32u32(extraOptsOffset);
  const composeMsgOffsetWord = word32u32(composeMsgOffset);
  const oftCmdOffsetWord     = word32u32(oftCmdOffset);

  // Dynamic data
  const extraOptsLen = Buffer.alloc(32);
  extraOptsLen.writeUInt32BE(extraOptions.length, 28);
  const extraOptsPadded = Buffer.alloc(extraOptsPaddedLen);
  extraOptions.copy(extraOptsPadded);

  const composeMsgLen = Buffer.alloc(32);  // composeMsg = empty bytes
  const oftCmdLen     = Buffer.alloc(32);  // oftCmd = empty bytes

  return Buffer.concat([
    outerOffset,
    dstEidWord, toBuf, amountWord, minAmtWord,
    extraOptsOffsetWord, composeMsgOffsetWord, oftCmdOffsetWord,
    extraOptsLen, extraOptsPadded,
    composeMsgLen,
    oftCmdLen,
  ]);
}

// ── LZ Native Drop option ─────────────────────
/**
 * Encode a NATIVE_DROP option for LZ V2 Type 3 options.
 * Drops a small amount of native token to the receiver on the destination chain.
 *
 * @param {bigint}  amount    - amount of native token to drop (in wei)
 * @param {string}  receiver  - 0x EVM address to receive the native drop
 */
export function encodeLzNativeDropOption(amount, receiver) {
  // Option data: [type=2:1][amount:16][receiver:32] = 49 bytes
  const optionData = Buffer.alloc(49);
  optionData[0] = 2;  // OPTION_TYPE_NATIVE_DROP
  // amount as u128 BE (16 bytes): high 8 + low 8
  optionData.writeBigUInt64BE(0n, 1);
  optionData.writeBigUInt64BE(BigInt(amount), 9);
  // receiver as bytes32 (32 bytes, left-zero-padded)
  const receiverBuf = evmAddressTo32(receiver);
  receiverBuf.copy(optionData, 17);

  // Worker block: [workerID=1][optionLen:u16 BE][optionData]
  const block = Buffer.alloc(3);
  block[0] = 1;  // Executor worker ID
  block.writeUInt16BE(optionData.length, 1);  // 49

  return Buffer.concat([
    Buffer.from([0x00, 0x03]),  // Type 3 header
    block,
    optionData,
  ]);
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
