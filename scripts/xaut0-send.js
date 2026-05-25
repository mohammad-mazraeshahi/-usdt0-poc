#!/usr/bin/env node
// ─────────────────────────────────────────────
//  XAUT0 OFT — Send from Solana to an EVM chain
//
//  Supports: Arbitrum (30110), Ethereum (30101), Celo (30125)
//  Single hop, no lzCompose.
//
//  Usage: edit AMOUNT_LD, DST_EID, DST_ADDR below, then run:
//    node scripts/xaut0-send.js
// ─────────────────────────────────────────────
import {
  Connection, Keypair, PublicKey,
  TransactionMessage, VersionedTransaction,
  TransactionInstruction, ComputeBudgetProgram,
} from '@solana/web3.js';
import { readFileSync } from 'fs';
import { EID, XAUT0_OFT_PROGRAM, XAUT0_ALT } from '../src/xaut0-constants.js';
import { encodeSendParams, evmAddressTo32 } from '../src/borsh.js';
import { buildSendAccounts } from '../src/xaut0-accounts.js';
import { quoteSend } from '../src/xaut0-quote.js';
import { getOftEventAuthority } from '../src/xaut0-pda.js';

// ── Config ────────────────────────────────────
const RPC         = 'https://api.mainnet-beta.solana.com';
const WALLET_PATH = '/root/usdt0-poc/test-wallet.json';

const DST_EID  = EID.ARBITRUM;
const DST_ADDR = '0x8b5b3F18db50713709da94f88f9f5EEc339D1E4E';

// Amount in 6-decimal units (1_000_000 = 1 XAUT0)
const AMOUNT_LD     = 100n;  // 0.0001 XAUT0
const MIN_AMOUNT_LD = 99n;   // ~1% slippage tolerance

// ── Main ──────────────────────────────────────
async function main() {
  const connection = new Connection(RPC, 'confirmed');
  const kp = Keypair.fromSecretKey(
    new Uint8Array(JSON.parse(readFileSync(WALLET_PATH, 'utf8'))),
  );

  const dstName = { [EID.ARBITRUM]: 'Arbitrum', [EID.ETH]: 'Ethereum', [EID.CELO]: 'Celo' }[DST_EID] ?? `EID ${DST_EID}`;
  console.log('Wallet:   ', kp.publicKey.toString());
  console.log('Amount:   ', Number(AMOUNT_LD) / 1e6, 'XAUT0 →', dstName);
  console.log('Recipient:', DST_ADDR);

  // ── 1. Quote fee ────────────────────────────
  console.log('\n[1/4] Quoting LZ fee...');
  const { nativeFee } = await quoteSend(
    connection, DST_EID, DST_ADDR, AMOUNT_LD, null, kp.publicKey,
  );
  if (nativeFee === 0n) throw new Error('Fee quote returned 0 — aborting');
  console.log(`  Fee: ${nativeFee} lamports (${Number(nativeFee) / 1e9} SOL)`);

  // ── 2. Build accounts ───────────────────────
  console.log('\n[2/4] Resolving accounts...');
  const { coreAccounts, remainingAccounts, altAddress } = await buildSendAccounts(
    connection, kp.publicKey, DST_EID,
  );

  // ── 3. Build instruction ────────────────────
  console.log('\n[3/4] Building send instruction...');
  const [oftEventAuth] = getOftEventAuthority();

  const allAccounts = [
    ...coreAccounts,
    { pubkey: oftEventAuth,                     isSigner: false, isWritable: false }, // pos 7
    { pubkey: new PublicKey(XAUT0_OFT_PROGRAM), isSigner: false, isWritable: false }, // pos 8
    ...remainingAccounts,
  ];

  const ixData = encodeSendParams({
    dstEid:       DST_EID,
    to:           evmAddressTo32(DST_ADDR),
    amountLd:     AMOUNT_LD,
    minAmountLd:  MIN_AMOUNT_LD,
    extraOptions: Buffer.alloc(0),
    composeMsg:   null,
    nativeFee,
    lzTokenFee:   0n,
  });

  const sendIx = new TransactionInstruction({
    programId: new PublicKey(XAUT0_OFT_PROGRAM),
    keys:      allAccounts,
    data:      ixData,
  });

  // ── 4. Load ALT + send ──────────────────────
  console.log('\n[4/4] Loading ALT and sending...');
  let altAccount = null;
  try {
    const resp = await connection.getAddressLookupTable(altAddress);
    altAccount = resp.value;
    if (altAccount) console.log(`  ALT: ${altAddress.toBase58()} (${altAccount.state.addresses.length} entries)`);
  } catch (e) {
    console.warn('  Could not load ALT:', e.message);
  }

  const cuIx   = ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 });
  const prioIx = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 5_000 });

  const { blockhash } = await connection.getLatestBlockhash();
  const msg = new TransactionMessage({
    payerKey:        kp.publicKey,
    recentBlockhash: blockhash,
    instructions:    [cuIx, prioIx, sendIx],
  }).compileToV0Message(altAccount ? [altAccount] : []);

  const tx = new VersionedTransaction(msg);
  tx.sign([kp]);

  // Simulate first
  const sim = await connection.simulateTransaction(tx, { commitment: 'confirmed' });
  if (sim.value.err) {
    console.error('❌ Simulation failed:', sim.value.err);
    console.error('Logs:\n', sim.value.logs?.slice(-20).join('\n'));
    process.exit(1);
  }
  console.log('✅ Simulation OK');

  // Broadcast
  const sig = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: true,
    maxRetries:    3,
  });
  console.log('\n🚀 Sent!');
  console.log('Signature:', sig);
  console.log(`Solscan:   https://solscan.io/tx/${sig}`);
  console.log(`LZ Scan:   https://layerzeroscan.com/tx/${sig}`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
