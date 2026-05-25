// ─────────────────────────────────────────────
//  XAUT0 PDA & Account Derivation
//
//  Key differences from USDT0:
//  - OFT store is a hardcoded keypair account (not a PDA)
//  - Peer seed includes OFT store: ["Peer", store_bytes, eid_BE_u32]
//  - No Credits PDA
//  - All LZ PDAs (endpoint, send lib, DVNs) are identical to USDT0
// ─────────────────────────────────────────────
import { PublicKey } from '@solana/web3.js';
import { XAUT0_OFT_PROGRAM, XAUT0_OFT_STORE, PROGRAMS } from './xaut0-constants.js';

const OFT_PROGRAM  = new PublicKey(XAUT0_OFT_PROGRAM);
const OFT_STORE_PK = new PublicKey(XAUT0_OFT_STORE);
const ENDPOINT     = new PublicKey(PROGRAMS.LZ_ENDPOINT);
const SEND_LIB     = new PublicKey(PROGRAMS.SEND_LIB);
const EXECUTOR_PK  = new PublicKey(PROGRAMS.EXECUTOR);

function eidBuf(eid) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(eid, 0);
  return b;
}

// ── XAUT0 OFT Program PDAs ───────────────────

/** OFT Store is a keypair account — return the hardcoded address */
export function getOftStore() {
  return [OFT_STORE_PK, 0];
}

/**
 * XAUT0 peer PDA includes the OFT store in its seed:
 *   PDA(["Peer", oft_store_bytes, eid_BE_u32], OFT_PROGRAM)
 *
 * USDT0 peer seed omits the store: PDA(["Peer", eid_BE_u32], OFT_PROGRAM)
 */
export function getPeer(dstEid) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('Peer'), OFT_STORE_PK.toBytes(), eidBuf(dstEid)],
    OFT_PROGRAM,
  );
}

/** Event authority for emit_cpi */
export function getOftEventAuthority() {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('__event_authority')],
    OFT_PROGRAM,
  );
}

// ── LZ Endpoint PDAs ─────────────────────────

export function getEndpointSettings() {
  return PublicKey.findProgramAddressSync([Buffer.from('Endpoint')], ENDPOINT);
}

export function getSendLibraryConfig(oapp, dstEid) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('SendLibraryConfig'), oapp.toBytes(), eidBuf(dstEid)],
    ENDPOINT,
  );
}

export function getDefaultSendLibraryConfig(dstEid) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('SendLibraryConfig'), eidBuf(dstEid)],
    ENDPOINT,
  );
}

export function getMessageLibInfo(msgLibPda) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('MessageLib'), msgLibPda.toBytes()],
    ENDPOINT,
  );
}

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

export function getUlnSetting() {
  return PublicKey.findProgramAddressSync([Buffer.from('MessageLib')], SEND_LIB);
}

export function getUlnSendConfig(dstEid, oapp) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('SendConfig'), eidBuf(dstEid), oapp.toBytes()],
    SEND_LIB,
  );
}

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

export function getExecutorConfig() {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('ExecutorConfig')],
    EXECUTOR_PK,
  );
}

// ── DVN PDAs ─────────────────────────────────

export function getDvnLzConfig() {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('PriceFeed')],
    new PublicKey(PROGRAMS.DVN_LZ),
  );
}

export function getDvnConfig(dvnProgramId) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('DvnConfig')],
    new PublicKey(dvnProgramId),
  );
}
