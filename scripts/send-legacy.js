#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
//  USDT0 OFT — Send from Solana to a LEGACY chain (e.g. Ethereum)
//  Legacy chains: ETH, Arbitrum, Celo, Tron, TON
//  Single hop: Solana → dest (no compose message)
// ═══════════════════════════════════════════════════════════════
import {
  Connection, Keypair, PublicKey,
  TransactionMessage, VersionedTransaction,
  TransactionInstruction, ComputeBudgetProgram,
} from '@solana/web3.js';
import { readFileSync } from 'fs';
import { EID, PROGRAMS } from '../src/constants.js';
import { encodeSendParams, evmAddressTo32 } from '../src/borsh.js';
import { buildSendAccounts } from '../src/accounts.js';
import { quoteSend } from '../src/quote.js';
import { getOftEventAuthority } from '../src/pda.js';

// ── Config ────────────────────────────────────
const RPC        = 'https://api.mainnet-beta.solana.com';
const WALLET_PATH = '/root/usdt0-poc/test-wallet.json';

// Destination: Ethereum (legacy)
const DST_EID    = EID.ETH;
const DST_ADDR   = '0x8b5b3F18db50713709da94f88f9f5EEc339D1E4E';  // your EVM wallet

// Amount: 0.001 USDT = 1000 micro-USDT
const AMOUNT_LD  = 1000n;   // 1000 = 0.001 USDT (6 decimals)
const SLIPPAGE   = 990n;    // min = 0.99x (1% slippage tolerance)

// ── Main ──────────────────────────────────────
async function main() {
  const connection = new Connection(RPC, 'confirmed');
  const kp = Keypair.fromSecretKey(
    new Uint8Array(JSON.parse(readFileSync(WALLET_PATH, 'utf8'))),
  );
  console.log('Wallet:', kp.publicKey.toString());

  // ── 1. Quote fee ────────────────────────────
  console.log(`\n[1/4] Quoting fee for ${Number(AMOUNT_LD)/1e6} USDT → ETH (EID ${DST_EID})...`);
  const { nativeFee, lzFee } = await quoteSend(
    connection, DST_EID, DST_ADDR, AMOUNT_LD, null, kp.publicKey,
  );
  console.log(`  Native fee: ${nativeFee} lamports (${Number(nativeFee)/1e9} SOL)`);
  console.log(`  LZ token fee: ${lzFee}`);

  if (nativeFee === 0n) {
    throw new Error('Fee quote returned 0 — check simulation');
  }

  // Add 10% buffer to native fee
  const nativeFeeWithBuffer = nativeFee * 110n / 100n;
  console.log(`  Fee with 10% buffer: ${nativeFeeWithBuffer} lamports`);

  // ── 2. Build accounts ───────────────────────
  console.log('\n[2/4] Resolving accounts...');
  const { coreAccounts, remainingAccounts, altAddress } = await buildSendAccounts(
    connection, kp.publicKey, DST_EID,
  );

  // ── 3. Build instruction ────────────────────
  console.log('\n[3/4] Building send instruction...');
  const to32 = evmAddressTo32(DST_ADDR);

  const ixData = encodeSendParams({
    dstEid:      DST_EID,
    to:          to32,
    amountLd:    AMOUNT_LD,
    minAmountLd: SLIPPAGE,
    extraOptions: Buffer.alloc(0),
    composeMsg:  null,           // no compose for legacy
    nativeFee:   nativeFeeWithBuffer,
    lzTokenFee:  0n,
  });

  // Positions 8-9 added manually between coreAccounts and remainingAccounts:
  //   8: oft_event_auth  (emit_cpi pattern)
  //   9: OFT program     (self-reference for emit_cpi)
  const [oftEventAuth] = getOftEventAuthority();

  const allAccounts = [
    ...coreAccounts,
    { pubkey: oftEventAuth, isSigner: false, isWritable: false }, // event authority
    { pubkey: new PublicKey(PROGRAMS.OFT), isSigner: false, isWritable: false }, // self (for emit_cpi)
    ...remainingAccounts,
  ];

  const sendIx = new TransactionInstruction({
    programId: new PublicKey(PROGRAMS.OFT),
    keys:      allAccounts,
    data:      ixData,
  });

  // Compute budget
  const cuIx   = ComputeBudgetProgram.setComputeUnitLimit({ units: 500_000 });
  const prioIx = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 5_000 });

  // ── 4. Fetch ALT and build versioned tx ─────
  console.log('\n[4/4] Fetching Address Lookup Table and sending...');
  // altAddress comes from OFTStore.alt (read by buildSendAccounts)
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
    payerKey:           kp.publicKey,
    recentBlockhash:    blockhash,
    instructions:       [cuIx, prioIx, sendIx],
  }).compileToV0Message(altAccount ? [altAccount] : []);

  const tx = new VersionedTransaction(msg);
  tx.sign([kp]);

  // ── Simulate first ───────────────────────────
  console.log('\nSimulating transaction...');
  const sim = await connection.simulateTransaction(tx, { commitment: 'confirmed' });
  if (sim.value.err) {
    console.error('Simulation failed:', sim.value.err);
    console.error('Logs:', sim.value.logs?.slice(-15).join('\n'));
    process.exit(1);
  }
  console.log('✅ Simulation OK');
  console.log('Logs:', sim.value.logs?.filter(l => l.includes('Program log')).join('\n'));

  // ── Send ─────────────────────────────────────
  const sig = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: true,
    maxRetries: 3,
  });
  console.log('\n🚀 Sent!');
  console.log('Signature:', sig);
  console.log(`Solscan: https://solscan.io/tx/${sig}`);
  console.log(`LZ Scan: https://layerzeroscan.com/tx/${sig}`);
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
