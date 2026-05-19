#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
//  USDT0 OFT — Send from Solana to an ADAPTIVE chain (e.g. Berachain)
//
//  Adaptive chains cannot receive directly from Solana.
//  Path: Solana → Arbitrum (leg 1) → Berachain (leg 2)
//
//  Implementation:
//    - Leg 1: OFT.send( dstEid=ARBITRUM, to=ARBITRUM_OFT, composeMsg=<leg2> )
//    - Leg 2: encoded in composeMsg — Arbitrum OFT executes another send
//             to Berachain upon receiving the compose message
//
//  The compose message payload is ABI-encoded and interpreted by the
//  USDT0 compose receiver on Arbitrum (0x77652d5a...).
// ═══════════════════════════════════════════════════════════════
import {
  Connection, Keypair, PublicKey,
  TransactionMessage, VersionedTransaction,
  TransactionInstruction, ComputeBudgetProgram,
} from '@solana/web3.js';
import { readFileSync } from 'fs';
import { EID, EVM_OFT, PROGRAMS } from '../src/constants.js';
import { encodeSendParams, evmAddressTo32, encodeComposeMsg } from '../src/borsh.js';
import { buildSendAccounts } from '../src/accounts.js';
import { quoteSend } from '../src/quote.js';
import { getOftStore, getOftEventAuthority } from '../src/pda.js';

// ── Config ────────────────────────────────────
const RPC         = 'https://api.mainnet-beta.solana.com';
const WALLET_PATH = '/root/usdt0-poc/test-wallet.json';

// Leg 1: Solana → Arbitrum
const LEG1_DST_EID = EID.ARBITRUM;
// Leg 2: Arbitrum → Berachain
const FINAL_EID    = EID.BERACHAIN;
const DST_ADDR     = '0x8b5b3F18db50713709da94f88f9f5EEc339D1E4E';  // your EVM wallet

// Amount: 0.001 USDT
const AMOUNT_LD  = 1000n;
const SLIPPAGE   = 990n;   // 1% slippage tolerance

// ── Main ──────────────────────────────────────
async function main() {
  const connection = new Connection(RPC, 'confirmed');
  const kp = Keypair.fromSecretKey(
    new Uint8Array(JSON.parse(readFileSync(WALLET_PATH, 'utf8'))),
  );
  console.log('Wallet:', kp.publicKey.toString());
  console.log(`\nRoute: Solana → Arbitrum (EID ${LEG1_DST_EID}) → Berachain (EID ${FINAL_EID})`);

  // ── 1. Build compose message (leg 2 payload) ─
  console.log('\n[1/5] Building compose message for leg 2...');
  // This ABI-encoded payload is executed by the compose receiver on Arbitrum.
  // It tells Arbitrum USDT0 OFT to forward tokens to Berachain.
  const composeMsg = encodeComposeMsg(
    FINAL_EID,        // final destination: Berachain
    DST_ADDR,         // final recipient
    SLIPPAGE,         // minAmountLD on final chain
    Buffer.alloc(0),  // no extra options for second hop
  );
  console.log(`  Compose msg (${composeMsg.length} bytes): ${composeMsg.toString('hex').slice(0, 64)}...`);

  // ── 2. Quote fee for leg 1 ──────────────────
  console.log('\n[2/5] Quoting fee for leg 1 (Solana → Arbitrum with compose)...');

  // The "to" for leg 1 is the Arbitrum OFT contract (32-byte padded)
  const arbOftAddr = EVM_OFT[LEG1_DST_EID];
  console.log(`  Sending to Arbitrum OFT: ${arbOftAddr}`);

  const { nativeFee, lzFee } = await quoteSend(
    connection, LEG1_DST_EID, arbOftAddr, AMOUNT_LD, composeMsg, kp.publicKey,
  );
  console.log(`  Native fee: ${nativeFee} lamports (${Number(nativeFee)/1e9} SOL)`);

  if (nativeFee === 0n) {
    throw new Error('Fee quote returned 0 — check simulation. composeMsg might be wrong format.');
  }

  const nativeFeeWithBuffer = nativeFee * 110n / 100n;
  console.log(`  Fee with 10% buffer: ${nativeFeeWithBuffer} lamports`);

  // ── 3. Build accounts ───────────────────────
  console.log('\n[3/5] Resolving accounts for leg 1...');
  const { coreAccounts, remainingAccounts, altAddress } = await buildSendAccounts(
    connection, kp.publicKey, LEG1_DST_EID,
  );

  // ── 4. Build instruction ────────────────────
  console.log('\n[4/5] Building send instruction...');
  const to32 = evmAddressTo32(arbOftAddr); // leg 1 recipient = Arbitrum OFT

  const ixData = encodeSendParams({
    dstEid:       LEG1_DST_EID,
    to:           to32,
    amountLd:     AMOUNT_LD,
    minAmountLd:  SLIPPAGE,
    extraOptions: Buffer.alloc(0),
    composeMsg,               // ← compose message triggers leg 2
    nativeFee:    nativeFeeWithBuffer,
    lzTokenFee:   0n,
  });

  const [oftEventAuth] = getOftEventAuthority();
  const allAccounts = [
    ...coreAccounts,
    { pubkey: oftEventAuth, isSigner: false, isWritable: false },
    { pubkey: new PublicKey(PROGRAMS.OFT), isSigner: false, isWritable: false },
    ...remainingAccounts,
  ];

  const sendIx = new TransactionInstruction({
    programId: new PublicKey(PROGRAMS.OFT),
    keys:      allAccounts,
    data:      ixData,
  });

  const cuIx   = ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 });
  const prioIx = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 5_000 });

  // ── 5. Build, simulate, send ─────────────────
  console.log('\n[5/5] Sending...');
  // Fetch ALT (stored in OFTStore.alt — already read by buildSendAccounts)
  let altAccount = null;
  if (altAddress) {
    try {
      const resp = await connection.getAddressLookupTable(altAddress);
      altAccount = resp.value;
      if (altAccount) console.log(`  ALT loaded: ${altAddress.toString()}`);
    } catch (e) {
      console.warn('  Could not load ALT:', e.message);
    }
  } else {
    console.warn('  No ALT in OFT store — sending without ALT (may exceed tx size)');
  }

  const { blockhash } = await connection.getLatestBlockhash();
  const msg = new TransactionMessage({
    payerKey:        kp.publicKey,
    recentBlockhash: blockhash,
    instructions:    [cuIx, prioIx, sendIx],
  }).compileToV0Message(altAccount ? [altAccount] : []);

  const tx = new VersionedTransaction(msg);
  tx.sign([kp]);

  // Simulate first
  console.log('Simulating...');
  const sim = await connection.simulateTransaction(tx, { commitment: 'confirmed' });
  if (sim.value.err) {
    console.error('Simulation failed:', sim.value.err);
    console.error('Logs:\n', sim.value.logs?.slice(-20).join('\n'));
    process.exit(1);
  }
  console.log('✅ Simulation OK');

  const sig = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: true,
    maxRetries: 3,
  });
  console.log('\n🚀 Sent!');
  console.log('Leg 1 signature:', sig);
  console.log(`Solscan: https://solscan.io/tx/${sig}`);
  console.log(`LZ Scan (watch for 2 messages): https://layerzeroscan.com/tx/${sig}`);
  console.log('\nNote: Leg 2 (Arbitrum→Berachain) is triggered automatically by the compose message.');
  console.log('Expect 2 messages on LZ Scan.');
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
