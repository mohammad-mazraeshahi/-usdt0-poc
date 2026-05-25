// ─────────────────────────────────────────────
//  XAUT0 quoteSend — simulate quote_send to get LZ fee
//
//  Differences from USDT0 quoteSend:
//  - No Credits account in named accounts
//  - token_mint included in named accounts (pos 2)
//  - 3 DVN workers: DVN_2, DVN_4, DVN_3
// ─────────────────────────────────────────────
import {
  Connection, PublicKey,
  TransactionMessage, VersionedTransaction,
  TransactionInstruction, ComputeBudgetProgram,
} from '@solana/web3.js';
import { XAUT0_OFT_PROGRAM, XAUT0_MINT, PROGRAMS } from './xaut0-constants.js';
import { encodeQuoteSendParams, evmAddressTo32 } from './borsh.js';
import {
  getOftStore, getPeer,
  getSendLibraryConfig, getDefaultSendLibraryConfig,
  getMessageLibInfo, getUlnSetting,
  getEndpointSettings, getNonce,
  getUlnSendConfig, getUlnDefaultSendConfig,
  getExecutorConfig, getDvnConfig, getDvnLzConfig,
} from './xaut0-pda.js';
import { getPeerAddress } from './xaut0-accounts.js';

const OFT_PROGRAM = new PublicKey(XAUT0_OFT_PROGRAM);
const MINT        = new PublicKey(XAUT0_MINT);
const ENDPOINT    = new PublicKey(PROGRAMS.LZ_ENDPOINT);
const SEND_LIB    = new PublicKey(PROGRAMS.SEND_LIB);
const EXECUTOR    = new PublicKey(PROGRAMS.EXECUTOR);
const DVN_LZ      = new PublicKey(PROGRAMS.DVN_LZ);
const DVN_2       = new PublicKey(PROGRAMS.DVN_2);
const DVN_3       = new PublicKey(PROGRAMS.DVN_3);
const DVN_4       = new PublicKey(PROGRAMS.DVN_4);

function ro(pubkey) {
  return { pubkey, isSigner: false, isWritable: false };
}

/**
 * Simulate XAUT0 quoteSend and return the native fee in lamports.
 *
 * @param {Connection}  connection
 * @param {number}      dstEid
 * @param {string}      receiverAddr   - 0x EVM address
 * @param {bigint}      amountLd       - amount in 6-decimal units
 * @param {Buffer|null} composeMsg
 * @param {PublicKey}   [payer]
 * @param {Buffer}      [extraOptions]
 * @returns {Promise<{ nativeFee: bigint, lzFee: bigint }>}
 */
export async function quoteSend(
  connection, dstEid, receiverAddr, amountLd,
  composeMsg = null, payer = null, extraOptions = Buffer.alloc(0),
) {
  const to32 = evmAddressTo32(receiverAddr);

  const [oftStorePda] = getOftStore();
  const [peerPda]     = getPeer(dstEid);
  const peerAddress32 = await getPeerAddress(connection, dstEid);

  const [ulnSettingPda]    = getUlnSetting();
  const [msgLibInfo]       = getMessageLibInfo(ulnSettingPda);
  const [endpointSettings] = getEndpointSettings();
  const [noncePda]         = getNonce(oftStorePda, dstEid, peerAddress32);
  const [sendLibCfg]       = getSendLibraryConfig(oftStorePda, dstEid);
  const [defSendLibCfg]    = getDefaultSendLibraryConfig(dstEid);
  const [ulnSendCfg]       = getUlnSendConfig(dstEid, oftStorePda);
  const [ulnDefCfg]        = getUlnDefaultSendConfig(dstEid);
  const [executorCfg]      = getExecutorConfig();
  const [dvnLzCfgPda]      = getDvnLzConfig();
  const [dvn2CfgPda]       = getDvnConfig(PROGRAMS.DVN_2);
  const [dvn3CfgPda]       = getDvnConfig(PROGRAMS.DVN_3);
  const [dvn4CfgPda]       = getDvnConfig(PROGRAMS.DVN_4);

  // Named accounts: oft_store(0), peer(1), token_mint(2)
  // remaining[0] must be endpoint program (construct_context requirement)
  // DVN worker order: DVN_2, DVN_4, DVN_3 (confirmed from on-chain analysis)
  const keys = [
    /* 0 */ ro(oftStorePda),       // oft_store
    /* 1 */ ro(peerPda),           // peer
    /* 2 */ ro(MINT),              // token_mint

    // Endpoint quote (3-9)
    /* 3 */ ro(ENDPOINT),          // endpoint program
    /* 4 */ ro(SEND_LIB),          // send_library_program
    /* 5 */ ro(sendLibCfg),        // send_library_config
    /* 6 */ ro(defSendLibCfg),     // default_send_library_config
    /* 7 */ ro(msgLibInfo),        // send_library_info
    /* 8 */ ro(endpointSettings),  // endpoint_settings
    /* 9 */ ro(noncePda),          // nonce

    // ULN quote (10-12)
    /* 10 */ ro(ulnSettingPda),    // uln
    /* 11 */ ro(ulnSendCfg),       // send_config
    /* 12 */ ro(ulnDefCfg),        // default_send_config

    // Executor worker (13-16)
    /* 13 */ ro(EXECUTOR),         // executor_program
    /* 14 */ ro(executorCfg),      // executor_config
    /* 15 */ ro(DVN_LZ),           // price_feed_program
    /* 16 */ ro(dvnLzCfgPda),      // price_feed_config

    // DVN_2 worker (17-20)
    /* 17 */ ro(DVN_2),
    /* 18 */ ro(dvn2CfgPda),
    /* 19 */ ro(DVN_LZ),
    /* 20 */ ro(dvnLzCfgPda),

    // DVN_4 worker (21-24)
    /* 21 */ ro(DVN_4),
    /* 22 */ ro(dvn4CfgPda),
    /* 23 */ ro(DVN_LZ),
    /* 24 */ ro(dvnLzCfgPda),

    // DVN_3 worker (25-28)
    /* 25 */ ro(DVN_3),
    /* 26 */ ro(dvn3CfgPda),
    /* 27 */ ro(DVN_LZ),
    /* 28 */ ro(dvnLzCfgPda),
  ];

  const data = encodeQuoteSendParams({
    dstEid,
    to:          to32,
    amountLd,
    minAmountLd: amountLd * 99n / 100n,
    extraOptions,
    composeMsg,
    payInLzToken: false,
  });

  const ix = new TransactionInstruction({ programId: OFT_PROGRAM, keys, data });
  const cuIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 500_000 });

  const { blockhash } = await connection.getLatestBlockhash();
  const msg = new TransactionMessage({
    payerKey:        payer ?? oftStorePda,
    recentBlockhash: blockhash,
    instructions:    [cuIx, ix],
  }).compileToV0Message([]);

  const sim = await connection.simulateTransaction(new VersionedTransaction(msg), {
    commitment: 'confirmed',
  });

  if (sim.value.err) {
    const logs = sim.value.logs ?? [];
    console.error('quoteSend simulation error:', sim.value.err);
    console.error('Last logs:\n', logs.slice(-10).join('\n'));
    throw new Error(`XAUT0 quoteSend failed: ${JSON.stringify(sim.value.err)}`);
  }

  if (sim.value.returnData) {
    const raw = Buffer.from(sim.value.returnData.data[0], 'base64');
    return {
      nativeFee: raw.readBigUInt64LE(0),
      lzFee:     raw.readBigUInt64LE(8),
    };
  }

  console.warn('quoteSend: no return data. Logs:', sim.value.logs?.slice(-5));
  return { nativeFee: 0n, lzFee: 0n };
}
