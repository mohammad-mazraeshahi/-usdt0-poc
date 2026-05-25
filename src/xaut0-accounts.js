// ─────────────────────────────────────────────
//  XAUT0 Account resolution for OFT `send`
//
//  Core differences from USDT0:
//  - No Credits account (no rate limiter)
//  - Token escrow hardcoded (not an ATA)
//  - OFT store hardcoded (not a PDA)
//  - Peer PDA: ["Peer", store_bytes, eid]
//  - 3 required DVNs in order: DVN_2, DVN_4, DVN_3
// ─────────────────────────────────────────────
import { PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddress, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { XAUT0_MINT, XAUT0_TOKEN_ESCROW, XAUT0_ALT, PROGRAMS } from './xaut0-constants.js';
import {
  getOftStore, getPeer,
  getEndpointEventAuthority,
  getSendLibraryConfig, getDefaultSendLibraryConfig,
  getMessageLibInfo, getUlnSetting,
  getEndpointSettings, getNonce,
  getUlnSendConfig, getUlnDefaultSendConfig,
  getSendLibraryEventAuthority,
  getExecutorConfig, getDvnConfig, getDvnLzConfig,
} from './xaut0-pda.js';

const ENDPOINT = new PublicKey(PROGRAMS.LZ_ENDPOINT);
const SEND_LIB = new PublicKey(PROGRAMS.SEND_LIB);
const EXECUTOR = new PublicKey(PROGRAMS.EXECUTOR);
const DVN_LZ   = new PublicKey(PROGRAMS.DVN_LZ);
const DVN_2    = new PublicKey(PROGRAMS.DVN_2);
const DVN_3    = new PublicKey(PROGRAMS.DVN_3);
const DVN_4    = new PublicKey(PROGRAMS.DVN_4);
const MINT     = new PublicKey(XAUT0_MINT);
const ESCROW   = new PublicKey(XAUT0_TOKEN_ESCROW);
const SYSTEM   = new PublicKey(PROGRAMS.SYSTEM);

// ── Helpers ───────────────────────────────────

/** Read peer address bytes from on-chain PeerConfig account */
export async function getPeerAddress(connection, dstEid) {
  const [peerPda] = getPeer(dstEid);
  const info = await connection.getAccountInfo(peerPda);
  if (!info) throw new Error(`XAUT0 Peer PDA not found for EID ${dstEid}`);
  // PeerConfig layout: 8 discrim + peer_address [u8; 32]
  return info.data.slice(8, 40);
}

/** Sender's Associated Token Account for XAUT0 */
export async function getSenderAta(wallet) {
  return getAssociatedTokenAddress(MINT, wallet, true, TOKEN_PROGRAM_ID);
}

// ── Main builder ──────────────────────────────

/**
 * Build the full ordered account list for XAUT0 OFT `send`.
 *
 * Positions 0-6:   core accounts (payer, peer, store, senderAta, escrow, mint, tokenProg)
 * Positions 7-8:   oft_event_auth + oft_program (added by caller in send script)
 * Positions 9-42:  remaining_accounts (endpoint → ULN → executor → DVN workers)
 *
 * @returns {{ coreAccounts, remainingAccounts, altAddress: PublicKey }}
 */
export async function buildSendAccounts(connection, wallet, dstEid) {
  const [oftStorePda] = getOftStore();
  const [peerPda]     = getPeer(dstEid);

  const senderAta     = await getSenderAta(wallet);
  const peerAddress32 = await getPeerAddress(connection, dstEid);

  // ── Shared PDAs ──
  const [ulnSettingPda]    = getUlnSetting();
  const [messageLibInfo]   = getMessageLibInfo(ulnSettingPda);
  const [endpointSettings] = getEndpointSettings();
  const [epEventAuth]      = getEndpointEventAuthority();
  const [slEventAuth]      = getSendLibraryEventAuthority();
  const [executorCfg]      = getExecutorConfig();
  const [dvnLzCfgPda]      = getDvnLzConfig();
  const [dvn2CfgPda]       = getDvnConfig(PROGRAMS.DVN_2);
  const [dvn3CfgPda]       = getDvnConfig(PROGRAMS.DVN_3);
  const [dvn4CfgPda]       = getDvnConfig(PROGRAMS.DVN_4);

  // ── Per-chain PDAs ──
  const [sendLibCfg]    = getSendLibraryConfig(oftStorePda, dstEid);
  const [defSendLibCfg] = getDefaultSendLibraryConfig(dstEid);
  const [noncePda]      = getNonce(oftStorePda, dstEid, peerAddress32);
  const [ulnSendCfg]    = getUlnSendConfig(dstEid, oftStorePda);
  const [ulnDefCfg]     = getUlnDefaultSendConfig(dstEid);

  // ── Core accounts (pos 0-6) ──
  const coreAccounts = [
    /* 0 */ { pubkey: wallet,           isSigner: true,  isWritable: true  }, // payer
    /* 1 */ { pubkey: peerPda,          isSigner: false, isWritable: true  }, // peer config
    /* 2 */ { pubkey: oftStorePda,      isSigner: false, isWritable: true  }, // oft_store
    /* 3 */ { pubkey: senderAta,        isSigner: false, isWritable: true  }, // token_source
    /* 4 */ { pubkey: ESCROW,           isSigner: false, isWritable: true  }, // token_escrow
    /* 5 */ { pubkey: MINT,             isSigner: false, isWritable: true  }, // token_mint
    /* 6 */ { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, // token_program
  ];

  // ── Remaining accounts (pos 9-42) ──
  const remainingAccounts = [
    // Endpoint CPI block (9-18)
    /* 9  */ { pubkey: ENDPOINT,         isSigner: false, isWritable: false },
    /* 10 */ { pubkey: oftStorePda,      isSigner: false, isWritable: true  }, // oapp
    /* 11 */ { pubkey: SEND_LIB,         isSigner: false, isWritable: false },
    /* 12 */ { pubkey: sendLibCfg,       isSigner: false, isWritable: false },
    /* 13 */ { pubkey: defSendLibCfg,    isSigner: false, isWritable: false },
    /* 14 */ { pubkey: messageLibInfo,   isSigner: false, isWritable: false },
    /* 15 */ { pubkey: endpointSettings, isSigner: false, isWritable: false },
    /* 16 */ { pubkey: noncePda,         isSigner: false, isWritable: true  },
    /* 17 */ { pubkey: epEventAuth,      isSigner: false, isWritable: false },
    /* 18 */ { pubkey: ENDPOINT,         isSigner: false, isWritable: false }, // emit_cpi self-ref

    // ULN block (19-26)
    /* 19 */ { pubkey: ulnSettingPda,    isSigner: false, isWritable: false },
    /* 20 */ { pubkey: ulnSendCfg,       isSigner: false, isWritable: false },
    /* 21 */ { pubkey: ulnDefCfg,        isSigner: false, isWritable: false },
    /* 22 */ { pubkey: wallet,           isSigner: false, isWritable: true  }, // fee payer
    /* 23 */ { pubkey: SEND_LIB,         isSigner: false, isWritable: false },
    /* 24 */ { pubkey: SYSTEM,           isSigner: false, isWritable: false },
    /* 25 */ { pubkey: slEventAuth,      isSigner: false, isWritable: false },
    /* 26 */ { pubkey: SEND_LIB,         isSigner: false, isWritable: false }, // emit_cpi self-ref

    // Executor worker (27-30)
    /* 27 */ { pubkey: EXECUTOR,         isSigner: false, isWritable: false },
    /* 28 */ { pubkey: executorCfg,      isSigner: false, isWritable: true  },
    /* 29 */ { pubkey: DVN_LZ,           isSigner: false, isWritable: false }, // price feed
    /* 30 */ { pubkey: dvnLzCfgPda,      isSigner: false, isWritable: false },

    // DVN workers: order is DVN_2, DVN_4, DVN_3 (confirmed from on-chain tx analysis)
    // Each worker block: [dvn_program, dvn_config, price_feed_program, price_feed_config]

    // DVN_2 worker (31-34)
    /* 31 */ { pubkey: DVN_2,            isSigner: false, isWritable: false },
    /* 32 */ { pubkey: dvn2CfgPda,       isSigner: false, isWritable: true  },
    /* 33 */ { pubkey: DVN_LZ,           isSigner: false, isWritable: false },
    /* 34 */ { pubkey: dvnLzCfgPda,      isSigner: false, isWritable: false },

    // DVN_4 worker (35-38)
    /* 35 */ { pubkey: DVN_4,            isSigner: false, isWritable: false },
    /* 36 */ { pubkey: dvn4CfgPda,       isSigner: false, isWritable: true  },
    /* 37 */ { pubkey: DVN_LZ,           isSigner: false, isWritable: false },
    /* 38 */ { pubkey: dvnLzCfgPda,      isSigner: false, isWritable: false },

    // DVN_3 worker (39-42)
    /* 39 */ { pubkey: DVN_3,            isSigner: false, isWritable: false },
    /* 40 */ { pubkey: dvn3CfgPda,       isSigner: false, isWritable: true  },
    /* 41 */ { pubkey: DVN_LZ,           isSigner: false, isWritable: false },
    /* 42 */ { pubkey: dvnLzCfgPda,      isSigner: false, isWritable: false },
  ];

  return { coreAccounts, remainingAccounts, altAddress: new PublicKey(XAUT0_ALT) };
}
