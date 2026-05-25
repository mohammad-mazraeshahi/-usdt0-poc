#!/usr/bin/env node
// ─────────────────────────────────────────────
//  XAUT0 Diagnostics
//  Verifies all key accounts exist on-chain and runs quoteSend simulation
// ─────────────────────────────────────────────
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { readFileSync } from 'fs';
import {
  XAUT0_OFT_PROGRAM, XAUT0_OFT_STORE, XAUT0_MINT,
  XAUT0_TOKEN_ESCROW, EID, PROGRAMS,
} from '../src/xaut0-constants.js';
import {
  getOftStore, getPeer,
  getUlnSetting, getMessageLibInfo, getEndpointSettings,
  getNonce, getSendLibraryConfig, getDefaultSendLibraryConfig,
  getUlnSendConfig, getUlnDefaultSendConfig,
  getExecutorConfig, getDvnLzConfig, getDvnConfig,
} from '../src/xaut0-pda.js';
import { getPeerAddress, getSenderAta } from '../src/xaut0-accounts.js';
import { quoteSend } from '../src/xaut0-quote.js';

const RPC         = 'https://api.mainnet-beta.solana.com';
const WALLET_PATH = '/root/usdt0-poc/test-wallet.json';
const DST_EID     = EID.ARBITRUM;
const DST_ADDR    = '0x8b5b3F18db50713709da94f88f9f5EEc339D1E4E';

async function main() {
  const conn = new Connection(RPC, 'confirmed');
  const kp = Keypair.fromSecretKey(
    new Uint8Array(JSON.parse(readFileSync(WALLET_PATH, 'utf8'))),
  );
  console.log('Wallet:', kp.publicKey.toBase58());
  console.log('DST EID:', DST_EID, '(Arbitrum)\n');

  // ── Resolve accounts ──────────────────────
  const [oftStore]   = getOftStore();
  const [peerArb]    = getPeer(DST_EID);
  const [ulnSetting] = getUlnSetting();
  const [msgLibInfo] = getMessageLibInfo(ulnSetting);
  const [epSettings] = getEndpointSettings();
  const senderAta    = await getSenderAta(kp.publicKey);

  let peerAddr32;
  try {
    peerAddr32 = await getPeerAddress(conn, DST_EID);
    console.log('Peer(Arb) address:', '0x' + Buffer.from(peerAddr32).toString('hex'));
  } catch (e) {
    console.error('❌ Peer lookup failed:', e.message);
    return;
  }

  const [nonce]      = getNonce(oftStore, DST_EID, peerAddr32);
  const [sendLibCfg] = getSendLibraryConfig(oftStore, DST_EID);
  const [defSlCfg]   = getDefaultSendLibraryConfig(DST_EID);
  const [ulnSendCfg] = getUlnSendConfig(DST_EID, oftStore);
  const [ulnDefCfg]  = getUlnDefaultSendConfig(DST_EID);
  const [execCfg]    = getExecutorConfig();
  const [dvnLzCfg]   = getDvnLzConfig();
  const [dvn2Cfg]    = getDvnConfig(PROGRAMS.DVN_2);
  const [dvn3Cfg]    = getDvnConfig(PROGRAMS.DVN_3);
  const [dvn4Cfg]    = getDvnConfig(PROGRAMS.DVN_4);

  // ── Verify accounts ───────────────────────
  const toCheck = [
    ['OFT program (executable)',   XAUT0_OFT_PROGRAM],
    ['OFT store',                  XAUT0_OFT_STORE],
    ['Token mint',                 XAUT0_MINT],
    ['Token escrow',               XAUT0_TOKEN_ESCROW],
    ['Peer(Arb) PDA',              peerArb.toBase58()],
    ['Sender ATA',                 senderAta.toBase58()],
    ['Nonce PDA',                  nonce.toBase58()],
    ['SendLibCfg(Arb)',            sendLibCfg.toBase58()],
    ['DefSendLibCfg(Arb)',         defSlCfg.toBase58()],
    ['ULN Setting',                ulnSetting.toBase58()],
    ['MessageLibInfo',             msgLibInfo.toBase58()],
    ['EndpointSettings',           epSettings.toBase58()],
    ['UlnSendCfg(Arb)',            ulnSendCfg.toBase58()],
    ['UlnDefaultSendCfg(Arb)',     ulnDefCfg.toBase58()],
    ['ExecutorConfig',             execCfg.toBase58()],
    ['DVN_LZ PriceFeed',           dvnLzCfg.toBase58()],
    ['DVN_2 Config',               dvn2Cfg.toBase58()],
    ['DVN_3 Config',               dvn3Cfg.toBase58()],
    ['DVN_4 Config',               dvn4Cfg.toBase58()],
  ];

  const infos = await conn.getMultipleAccountsInfo(
    toCheck.map(([, k]) => new PublicKey(k)),
  );
  console.log('Account verification:');
  toCheck.forEach(([name, key], i) => {
    const info   = infos[i];
    const status = info ? `✅ (len=${info.data.length})` : '❌ NOT FOUND';
    console.log(`  ${name.padEnd(28)} ${key.slice(0, 8)}...  ${status}`);
  });

  // ── Token balance ─────────────────────────
  console.log('\nToken balances:');
  const tokenAccts = await conn.getParsedTokenAccountsByOwner(
    kp.publicKey, { mint: new PublicKey(XAUT0_MINT) },
  );
  if (tokenAccts.value.length === 0) {
    console.log('  ❌ No XAUT0 token account found for wallet');
    return;
  }
  const xautAcct = tokenAccts.value[0];
  console.log(`  Balance: ${xautAcct.account.data.parsed.info.tokenAmount.uiAmountString} XAUT0`);
  console.log(`  Account: ${xautAcct.pubkey.toBase58()}`);

  // ── quoteSend simulation ──────────────────
  console.log('\nquoteSend simulation (0.000001 XAUT0 → Arbitrum)...');
  try {
    const { nativeFee, lzFee } = await quoteSend(
      conn, DST_EID, DST_ADDR, 1n, null, kp.publicKey,
    );
    console.log('  ✅ OK');
    console.log(`  nativeFee: ${nativeFee} lamports (${Number(nativeFee) / 1e9} SOL)`);
    console.log(`  lzFee:     ${lzFee}`);
  } catch (e) {
    console.error('  ❌ Failed:', e.message);
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
