// ─────────────────────────────────────────────
//  Account resolution for OFT `send` instruction
//
//  40-account structure verified against real on-chain transactions.
//  Positions 0-7  = core accounts (Anchor struct)
//  Positions 8-9  = oft_event_auth + oft_program (added by caller)
//  Positions 10-39 = remaining_accounts (endpoint → ULN → executor → DVNs)
// ─────────────────────────────────────────────
import { PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddress, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { PROGRAMS, USDT0_MINT } from './constants.js';
import {
  getOftStore, getCredits, getPeer,
  getEndpointEventAuthority,
  getSendLibraryConfig, getDefaultSendLibraryConfig,
  getMessageLibInfo, getUlnSetting,
  getEndpointSettings, getNonce,
  getUlnSendConfig, getUlnDefaultSendConfig,
  getSendLibraryEventAuthority,
  getExecutorConfig, getDvnConfig, getDvnLzConfig,
} from './pda.js';

const ENDPOINT = new PublicKey(PROGRAMS.LZ_ENDPOINT);
const SEND_LIB = new PublicKey(PROGRAMS.SEND_LIB);
const EXECUTOR = new PublicKey(PROGRAMS.EXECUTOR);
const DVN_LZ   = new PublicKey(PROGRAMS.DVN_LZ);
const DVN_2    = new PublicKey(PROGRAMS.DVN_2);
const DVN_3    = new PublicKey(PROGRAMS.DVN_3);
const MINT     = new PublicKey(USDT0_MINT);
const SYSTEM   = new PublicKey('11111111111111111111111111111111');

// ── Helpers ───────────────────────────────────

/** Read peer address (32 bytes) from on-chain PeerConfig */
export async function getPeerAddress(connection, dstEid) {
  const [peerPda] = getPeer(dstEid);
  const info = await connection.getAccountInfo(peerPda);
  if (!info) throw new Error(`Peer PDA not found for EID ${dstEid}`);
  // PeerConfig: 8 discrim + peer_address [u8;32] + ...
  return info.data.slice(8, 40);
}

/**
 * Read token_escrow and alt from OFT store.
 * OFTStore layout (after 8-byte discriminator):
 *   token_mint         32
 *   token_escrow       32
 *   endpoint_program   32
 *   bump               1
 *   fee_balance        8
 *   super_admin        32
 *   planner            32
 *   lp_admin           32
 *   burn_and_nilify    32
 *   fee_bps            2
 *   alt  Option<Pubkey> — 1 flag + optional 32
 */
export async function getOftStoreData(connection) {
  const [oftStorePda] = getOftStore();
  const info = await connection.getAccountInfo(oftStorePda);
  if (!info) throw new Error('OFT store not found');
  const d = info.data;

  const tokenEscrow = new PublicKey(d.slice(8 + 32, 8 + 64));

  // ALT: offset 8 + 32 + 32 + 32 + 1 + 8 + 32 + 32 + 32 + 32 + 2 = 243
  let altAddress = null;
  if (d.length > 243 && d[243] === 1) {
    altAddress = new PublicKey(d.slice(244, 276));
  }

  return { tokenEscrow, altAddress };
}

/** Sender's Associated Token Account for USDT0 */
export async function getSenderAta(wallet) {
  // allowOwnerOffCurve=true: PDAs can own ATAs (needed for quoteSend simulation payer)
  return getAssociatedTokenAddress(MINT, wallet, true, TOKEN_PROGRAM_ID);
}

// ── Main builder ──────────────────────────────

/**
 * Build the full ordered account list for OFT `send`.
 *
 * Returns:
 *   coreAccounts      — positions 0-7  (wallet → token_program)
 *   remainingAccounts — positions 10-39 (endpoint → ULN → executor → DVNs)
 *   altAddress        — PublicKey | null  (the OFT's ALT; pass to compileToV0Message)
 *
 * Caller must insert at positions 8 and 9:
 *   { pubkey: oftEventAuth, isSigner: false, isWritable: false }
 *   { pubkey: OFT_PROGRAM,  isSigner: false, isWritable: false }
 */
export async function buildSendAccounts(connection, wallet, dstEid) {
  const [oftStorePda] = getOftStore();
  const [creditsPda]  = getCredits();
  const [peerPda]     = getPeer(dstEid);

  const senderAta                 = await getSenderAta(wallet);
  const { tokenEscrow, altAddress } = await getOftStoreData(connection);
  const peerAddress32             = await getPeerAddress(connection, dstEid);

  // ── Shared PDAs (same for all destination chains) ──
  const [ulnSettingPda]     = getUlnSetting();
  const [messageLibInfo]    = getMessageLibInfo(ulnSettingPda);
  const [endpointSettings]  = getEndpointSettings();
  const [epEventAuth]       = getEndpointEventAuthority();
  const [slEventAuth]       = getSendLibraryEventAuthority();
  const [executorCfg]       = getExecutorConfig();
  const [dvnLzCfgPda]       = getDvnLzConfig();                 // ["PriceFeed"] / DVN_LZ
  const [dvn2CfgPda]        = getDvnConfig(PROGRAMS.DVN_2);     // ["DvnConfig"] / DVN_2
  const [dvn3CfgPda]        = getDvnConfig(PROGRAMS.DVN_3);     // ["DvnConfig"] / DVN_3

  // ── Per-chain PDAs (change per destination EID) ──
  const [sendLibCfg]    = getSendLibraryConfig(oftStorePda, dstEid); // ["SendLibraryConfig", oapp, eid]
  const [defSendLibCfg] = getDefaultSendLibraryConfig(dstEid);       // ["SendLibraryConfig", eid]
  const [noncePda]      = getNonce(oftStorePda, dstEid, peerAddress32);
  const [ulnSendCfg]    = getUlnSendConfig(dstEid, oftStorePda);     // ["SendConfig", eid, oapp]
  const [ulnDefCfg]     = getUlnDefaultSendConfig(dstEid);           // ["SendConfig", eid]

  // ── Core accounts: positions 0-7 ─────────────
  const coreAccounts = [
    /* 0 */ { pubkey: wallet,          isSigner: true,  isWritable: true  }, // payer / signer
    /* 1 */ { pubkey: peerPda,         isSigner: false, isWritable: false }, // peer config
    /* 2 */ { pubkey: oftStorePda,     isSigner: false, isWritable: true  }, // oft_store
    /* 3 */ { pubkey: creditsPda,      isSigner: false, isWritable: true  }, // credits
    /* 4 */ { pubkey: senderAta,       isSigner: false, isWritable: true  }, // token_source (sender ATA)
    /* 5 */ { pubkey: tokenEscrow,     isSigner: false, isWritable: true  }, // token_escrow
    /* 6 */ { pubkey: MINT,            isSigner: false, isWritable: false }, // token_mint
    /* 7 */ { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, // token_program
  ];

  // Caller adds:
  // /* 8 */ oft_event_auth  PDA(["__event_authority"], OFT_PROGRAM)
  // /* 9 */ OFT_PROGRAM     (self, required by emit_cpi! macro)

  // ── Remaining accounts: positions 10-39 ──────
  const remainingAccounts = [

    // ─── Endpoint CPI block (pos 10-19) ──────────────────────
    /* 10 */ { pubkey: ENDPOINT,         isSigner: false, isWritable: false }, // lz_endpoint program
    /* 11 */ { pubkey: oftStorePda,      isSigner: false, isWritable: true  }, // oapp (same as pos 2)
    /* 12 */ { pubkey: SEND_LIB,         isSigner: false, isWritable: false }, // send_library program
    /* 13 */ { pubkey: sendLibCfg,       isSigner: false, isWritable: false }, // sendLibraryConfig (per-OApp+chain)
    /* 14 */ { pubkey: defSendLibCfg,    isSigner: false, isWritable: false }, // defaultSendLibraryConfig (per-chain)
    /* 15 */ { pubkey: messageLibInfo,   isSigner: false, isWritable: false }, // messageLibInfo (shared)
    /* 16 */ { pubkey: endpointSettings, isSigner: false, isWritable: false }, // endpoint_settings (shared)
    /* 17 */ { pubkey: noncePda,         isSigner: false, isWritable: true  }, // nonce (writable — incremented)
    /* 18 */ { pubkey: epEventAuth,      isSigner: false, isWritable: false }, // endpoint event_authority
    /* 19 */ { pubkey: ENDPOINT,         isSigner: false, isWritable: false }, // lz_endpoint (emit_cpi self-ref)

    // ─── ULN (Send Library) CPI block (pos 20-27) ────────────
    /* 20 */ { pubkey: ulnSettingPda,    isSigner: false, isWritable: false }, // uln_setting (shared)
    /* 21 */ { pubkey: ulnSendCfg,       isSigner: false, isWritable: false }, // ulnSendConfig (per-chain+oapp)
    /* 22 */ { pubkey: ulnDefCfg,        isSigner: false, isWritable: false }, // ulnDefaultSendConfig (per-chain)
    /* 23 */ { pubkey: wallet,           isSigner: false, isWritable: true  }, // payer (fee payer for nonce rent)
    /* 24 */ { pubkey: SEND_LIB,         isSigner: false, isWritable: false }, // send_library (emit_cpi self-ref)
    /* 25 */ { pubkey: SYSTEM,           isSigner: false, isWritable: false }, // system_program
    /* 26 */ { pubkey: slEventAuth,      isSigner: false, isWritable: false }, // uln event_authority
    /* 27 */ { pubkey: SEND_LIB,         isSigner: false, isWritable: false }, // send_library (emit_cpi self-ref 2)

    // ─── Executor + DVNs block (pos 28-39, ALL shared) ────────
    /* 28 */ { pubkey: EXECUTOR,         isSigner: false, isWritable: false }, // executor program
    /* 29 */ { pubkey: executorCfg,      isSigner: false, isWritable: true  }, // ExecutorConfig (writable)

    // DVN_LZ appears 3× (once per DVN slot in the ULN config)
    /* 30 */ { pubkey: DVN_LZ,           isSigner: false, isWritable: false }, // dvn_lz program
    /* 31 */ { pubkey: dvnLzCfgPda,      isSigner: false, isWritable: false }, // PriceFeed PDA (READONLY)

    /* 32 */ { pubkey: DVN_2,            isSigner: false, isWritable: false }, // dvn_2 program
    /* 33 */ { pubkey: dvn2CfgPda,       isSigner: false, isWritable: true  }, // DVN_2 DvnConfig (writable)

    /* 34 */ { pubkey: DVN_LZ,           isSigner: false, isWritable: false }, // dvn_lz program (repeated)
    /* 35 */ { pubkey: dvnLzCfgPda,      isSigner: false, isWritable: false }, // PriceFeed PDA (READONLY)

    /* 36 */ { pubkey: DVN_3,            isSigner: false, isWritable: false }, // dvn_3 program
    /* 37 */ { pubkey: dvn3CfgPda,       isSigner: false, isWritable: true  }, // DVN_3 DvnConfig (writable)

    /* 38 */ { pubkey: DVN_LZ,           isSigner: false, isWritable: false }, // dvn_lz program (repeated)
    /* 39 */ { pubkey: dvnLzCfgPda,      isSigner: false, isWritable: false }, // PriceFeed PDA (READONLY)
  ];

  return { coreAccounts, remainingAccounts, altAddress };
}
