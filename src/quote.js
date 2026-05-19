// ─────────────────────────────────────────────
//  quoteSend — simulate the OFT quote_send view function
//
//  quote_send account structure (from source):
//
//  OFT named (3):
//    0: oft_store
//    1: peer
//    2: token_mint
//
//  remaining_accounts → endpoint Quote CPI (6):
//    3: send_library_program
//    4: send_library_config
//    5: default_send_library_config
//    6: send_library_info
//    7: endpoint (EndpointSettings)
//    8: nonce
//
//  remaining → ULN Quote CPI (named: 3, then workers):
//    9:  uln (ULN Setting PDA)
//   10:  send_config (ULN per-chain+oapp)
//   11:  default_send_config (ULN per-chain default)
//
//  remaining → executor block (4):
//   12: executor_program
//   13: executor_config
//   14: price_feed_program (DVN_LZ)
//   15: price_feed_config  (DVN_LZ PriceFeed)
//
//  remaining → DVN_2 block (4):
//   16: dvn_program (DVN_2)
//   17: dvn_config  (dvn2CfgPda)
//   18: price_feed_program (DVN_LZ)
//   19: price_feed_config  (DVN_LZ PriceFeed)
//
//  remaining → DVN_3 block (4):
//   20: dvn_program (DVN_3)
//   21: dvn_config  (dvn3CfgPda)
//   22: price_feed_program (DVN_LZ)
//   23: price_feed_config  (DVN_LZ PriceFeed)
//
//  Total: 24 accounts, ALL read-only (endpoint enforces this for quote)
// ─────────────────────────────────────────────
import {
  Connection, PublicKey,
  TransactionMessage, VersionedTransaction,
  TransactionInstruction, ComputeBudgetProgram,
} from '@solana/web3.js';
import { PROGRAMS, USDT0_MINT } from './constants.js';
import { encodeQuoteSendParams, evmAddressTo32 } from './borsh.js';
import {
  getOftStore, getPeer, getCredits,
  getSendLibraryConfig, getDefaultSendLibraryConfig,
  getMessageLibInfo, getUlnSetting,
  getEndpointSettings, getNonce,
  getUlnSendConfig, getUlnDefaultSendConfig,
  getExecutorConfig, getDvnConfig, getDvnLzConfig,
} from './pda.js';
import { getPeerAddress, getOftStoreData } from './accounts.js';

const OFT_PROGRAM = new PublicKey(PROGRAMS.OFT);
const ENDPOINT    = new PublicKey(PROGRAMS.LZ_ENDPOINT);
const SEND_LIB    = new PublicKey(PROGRAMS.SEND_LIB);
const EXECUTOR    = new PublicKey(PROGRAMS.EXECUTOR);
const DVN_LZ      = new PublicKey(PROGRAMS.DVN_LZ);
const DVN_2       = new PublicKey(PROGRAMS.DVN_2);
const DVN_3       = new PublicKey(PROGRAMS.DVN_3);
const MINT        = new PublicKey(USDT0_MINT);

function ro(pubkey) {
  return { pubkey, isSigner: false, isWritable: false };
}

/**
 * Simulate quoteSend and return the native fee in lamports.
 *
 * @param {Connection}  connection
 * @param {number}      dstEid
 * @param {string}      receiverAddr   - 0x EVM address
 * @param {bigint}      amountLd       - amount in 6-decimal units
 * @param {Buffer|null} composeMsg     - null for legacy, buffer for adaptive
 * @param {PublicKey}   [payer]        - fee payer pubkey (any on-curve account with SOL)
 * @returns {Promise<{nativeFee: bigint, lzFee: bigint}>}
 */
export async function quoteSend(connection, dstEid, receiverAddr, amountLd, composeMsg = null, payer = null) {
  const to32 = evmAddressTo32(receiverAddr);

  const [oftStorePda] = getOftStore();
  const [peerPda]     = getPeer(dstEid);
  const [creditsPda]  = getCredits();

  // Fetch peer address (needed for nonce PDA derivation)
  const peerAddress32 = await getPeerAddress(connection, dstEid);

  // Load ALT for tx size compression
  const { altAddress } = await getOftStoreData(connection);
  let altAccount = null;
  if (altAddress) {
    const resp = await connection.getAddressLookupTable(altAddress);
    altAccount = resp.value;
  }

  // ── Derive all PDAs ───────────────────────────────────────────────
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

  // ── Build 23-account list (ALL read-only for quote) ───────────────
  // OFT named (3): oft_store, credits, peer  [from usdt-native-mesh QuoteSend struct]
  // remaining (20): endpoint Quote (6) + ULN Quote (3) + executor (4) + DVN×2 (4×2)
  const keys = [
    // OFT named accounts (from usdt-native-mesh/programs/oft/src/instructions/quote_send.rs)
    /* 0 */ ro(oftStorePda),          // oft_store
    /* 1 */ ro(creditsPda),           // credits (USDT0 rate limiter)
    /* 2 */ ro(peerPda),              // peer

    // construct_context() checks accounts[0].key() == endpoint_program
    // so the FIRST remaining account must be the endpoint program itself
    /* 3 */ ro(ENDPOINT),             // ← program ID check (construct_context requirement)

    // Endpoint Quote struct fields (remaining[1-6]):
    /* 4 */ ro(SEND_LIB),             // send_library_program
    /* 5 */ ro(sendLibCfg),           // send_library_config
    /* 6 */ ro(defSendLibCfg),        // default_send_library_config
    /* 7 */ ro(msgLibInfo),           // send_library_info
    /* 8 */ ro(endpointSettings),     // endpoint (EndpointSettings)
    /* 9 */ ro(noncePda),             // nonce

    // ULN Quote named accounts (endpoint's remaining → ULN named fields)
    // ULN is called via CpiContext::new_with_signer (NOT construct_context), so no program prefix
    // ULN Quote: endpoint(signer=msgLibInfo via CpiCtx), uln, send_config, default_send_config
    /* 10 */ ro(ulnSettingPda),        // uln
    /* 11 */ ro(ulnSendCfg),           // send_config (per-chain+oapp)
    /* 12 */ ro(ulnDefCfg),            // default_send_config (per-chain)

    // Executor block (4 accounts)
    /* 13 */ ro(EXECUTOR),            // executor_program
    /* 14 */ ro(executorCfg),         // executor_config
    /* 15 */ ro(DVN_LZ),              // price_feed_program (for executor)
    /* 16 */ ro(dvnLzCfgPda),         // price_feed_config

    // DVN_2 block (4 accounts)
    /* 17 */ ro(DVN_2),               // dvn_program
    /* 18 */ ro(dvn2CfgPda),          // dvn_config
    /* 19 */ ro(DVN_LZ),              // price_feed_program
    /* 20 */ ro(dvnLzCfgPda),         // price_feed_config

    // DVN_3 block (4 accounts)
    /* 21 */ ro(DVN_3),               // dvn_program
    /* 22 */ ro(dvn3CfgPda),          // dvn_config
    /* 23 */ ro(DVN_LZ),              // price_feed_program
    /* 24 */ ro(dvnLzCfgPda),         // price_feed_config
  ];

  const data = encodeQuoteSendParams({
    dstEid,
    to: to32,
    amountLd,
    minAmountLd: amountLd * 99n / 100n,
    extraOptions: Buffer.alloc(0),
    composeMsg,
    payInLzToken: false,
  });

  const ix = new TransactionInstruction({
    programId: OFT_PROGRAM,
    keys,
    data,
  });

  const cuIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 500_000 });

  // Use provided payer or fall back to a known funded account (e.g. OFT store)
  // Note: for simulation, payer just needs to be on-curve with some SOL
  const effectivePayer = payer ?? oftStorePda;

  const { blockhash } = await connection.getLatestBlockhash();
  const msg = new TransactionMessage({
    payerKey:        effectivePayer,
    recentBlockhash: blockhash,
    instructions:    [cuIx, ix],
  }).compileToV0Message(altAccount ? [altAccount] : []);

  const tx = new VersionedTransaction(msg);

  const sim = await connection.simulateTransaction(tx, { commitment: 'confirmed' });

  if (sim.value.err) {
    const logs = sim.value.logs ?? [];
    console.error('quoteSend simulation error:', sim.value.err);
    console.error('Last logs:', logs.slice(-10).join('\n'));
    throw new Error(`quoteSend simulation failed: ${JSON.stringify(sim.value.err)}`);
  }

  if (sim.value.returnData) {
    const raw = Buffer.from(sim.value.returnData.data[0], 'base64');
    const nativeFee = raw.readBigUInt64LE(0);
    const lzFee     = raw.readBigUInt64LE(8);
    return { nativeFee, lzFee };
  }

  // Fallback: no return data (some RPCs don't surface it)
  console.warn('quoteSend: no return data from simulation. Logs:', sim.value.logs?.slice(-5));
  return { nativeFee: 0n, lzFee: 0n };
}
