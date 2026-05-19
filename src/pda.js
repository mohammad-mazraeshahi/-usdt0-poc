// ─────────────────────────────────────────────
//  PDA & Account Derivation
//  Seeds verified against real on-chain txs and LZ SDK source:
//  @layerzerolabs/lz-solana-sdk-v2/src/pda.ts
// ─────────────────────────────────────────────
import { PublicKey } from '@solana/web3.js';
import { PROGRAMS, SEEDS } from './constants.js';

const OFT_PROGRAM = new PublicKey(PROGRAMS.OFT);
const ENDPOINT    = new PublicKey(PROGRAMS.LZ_ENDPOINT);
const SEND_LIB    = new PublicKey(PROGRAMS.SEND_LIB);
const EXECUTOR_PK = new PublicKey(PROGRAMS.EXECUTOR);

// ── Utility ──────────────────────────────────
function eidBuf(eid) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(eid, 0);
  return b;
}

// ── OFT Program PDAs ─────────────────────────

export function getOftStore() {
  return PublicKey.findProgramAddressSync([SEEDS.OFT], OFT_PROGRAM);
}

export function getCredits() {
  return PublicKey.findProgramAddressSync([SEEDS.CREDITS], OFT_PROGRAM);
}

export function getPeer(dstEid) {
  return PublicKey.findProgramAddressSync([SEEDS.PEER, eidBuf(dstEid)], OFT_PROGRAM);
}

export function getOftEventAuthority() {
  return PublicKey.findProgramAddressSync([Buffer.from('__event_authority')], OFT_PROGRAM);
}

// ── LZ Endpoint PDAs ─────────────────────────

export function getEndpointSettings() {
  return PublicKey.findProgramAddressSync([Buffer.from('Endpoint')], ENDPOINT);
}

// Per-OApp per-destination send library config
// Seeds: ["SendLibraryConfig", oapp_pubkey_bytes, dstEid_BE_u32]
export function getSendLibraryConfig(oapp, dstEid) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('SendLibraryConfig'), oapp.toBytes(), eidBuf(dstEid)],
    ENDPOINT,
  );
}

// Global default send library config for a destination chain
// Seeds: ["SendLibraryConfig", dstEid_BE_u32]
export function getDefaultSendLibraryConfig(dstEid) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('SendLibraryConfig'), eidBuf(dstEid)],
    ENDPOINT,
  );
}

// MessageLibInfo PDA — endpoint-owned account storing info about a message lib
// Seeds: ["MessageLib", msgLib_pubkey_bytes]  (msgLib = ULN setting PDA)
export function getMessageLibInfo(msgLibPda) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('MessageLib'), msgLibPda.toBytes()],
    ENDPOINT,
  );
}

// Outbound nonce PDA (per OApp, per dest EID, per peer receiver)
// Seeds: ["Nonce", sender_bytes, dstEid_BE_u32, receiver_bytes32]
export function getNonce(sender, dstEid, receiver32) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('Nonce'), sender.toBytes(), eidBuf(dstEid), Buffer.from(receiver32)],
    ENDPOINT,
  );
}

export function getEndpointEventAuthority() {
  return PublicKey.findProgramAddressSync([Buffer.from('__event_authority')], ENDPOINT);
}

// ── Send Library (ULN) PDAs ──────────────────

// ULN "MessageLib" setting PDA — the ULN's own store
// Seeds: ["MessageLib"]  (no EID, not per-OApp)
export function getUlnSetting() {
  return PublicKey.findProgramAddressSync([Buffer.from('MessageLib')], SEND_LIB);
}

// Per-OApp per-chain send config in ULN
// Seeds: ["SendConfig", dstEid_BE_u32, oapp_bytes]
export function getUlnSendConfig(dstEid, oapp) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('SendConfig'), eidBuf(dstEid), oapp.toBytes()],
    SEND_LIB,
  );
}

// Global default send config in ULN (per chain, no OApp)
// Seeds: ["SendConfig", dstEid_BE_u32]
export function getUlnDefaultSendConfig(dstEid) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('SendConfig'), eidBuf(dstEid)],
    SEND_LIB,
  );
}

export function getSendLibraryEventAuthority() {
  return PublicKey.findProgramAddressSync([Buffer.from('__event_authority')], SEND_LIB);
}

// ── Executor PDAs ────────────────────────────

// Executor global config (not per-OApp or per-chain)
// Seeds: ["ExecutorConfig"]
export function getExecutorConfig() {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('ExecutorConfig')],
    EXECUTOR_PK,
  );
}

// ── DVN PDAs ─────────────────────────────────

// DVN_LZ is a price-oracle DVN — its config PDA uses seed "PriceFeed" (not "DvnConfig")
// Seeds: ["PriceFeed"] under DVN_LZ program
export function getDvnLzConfig() {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('PriceFeed')],
    new PublicKey(PROGRAMS.DVN_LZ),
  );
}

// Standard DVN config for DVN_2 and DVN_3
// Seeds: ["DvnConfig"] under each DVN's own program
export function getDvnConfig(dvnProgramId) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('DvnConfig')],
    new PublicKey(dvnProgramId),
  );
}
