#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
//  USDT0 OFT — Send from Solana to an ADAPTIVE chain (Celo)
//
//  Adaptive chains cannot receive directly from Solana.
//  Path: Solana → Arbitrum (leg 1) → Celo (leg 2)
//
//  Implementation:
//    - Leg 1: OFT.send( dstEid=ARBITRUM, to=ARBITRUM_OFT, composeMsg=<leg2> )
//    - Leg 2: encoded in composeMsg — Arbitrum OFT executes another send
//             to Celo upon receiving the compose message
//
//  Valid adaptive destinations (peers on Arb USDT0):
//    ETH (30101) ✅, Celo (30125) ✅, TON (30343) ✅, Tron (30420) ✅
//    Berachain ❌, Base ❌, Optimism ❌  (not configured on Arb)
//
//  Key parameters for the lzCompose option:
//    - gas:   executor gas for lzCompose call on Arbitrum (≥ 500k for safety)
//    - value: ETH to forward as msg.value to the compose callback, which the
//             compose receiver uses to pay the leg 2 LZ fee.
//             Must be quoted from the Arbitrum USDT0 OFT's quoteSend().
// ═══════════════════════════════════════════════════════════════
import {
  Connection, Keypair, PublicKey,
  TransactionMessage, VersionedTransaction,
  TransactionInstruction, ComputeBudgetProgram,
} from '@solana/web3.js';
import { readFileSync } from 'fs';
import { EID, EVM_OFT, PROGRAMS } from '../src/constants.js';
import { encodeSendParams, evmAddressTo32, encodeComposeMsg, encodeLzComposeOption } from '../src/borsh.js';
import { buildSendAccounts } from '../src/accounts.js';
import { quoteSend } from '../src/quote.js';
import { getOftEventAuthority } from '../src/pda.js';

// ── Config ────────────────────────────────────
const RPC         = 'https://api.mainnet-beta.solana.com';
const ARB_RPC     = 'https://arb1.arbitrum.io/rpc';
const WALLET_PATH = '/root/usdt0-poc/test-wallet.json';

// Route: Solana → Arbitrum (leg 1) → Celo (leg 2)
const LEG1_DST_EID = EID.ARBITRUM;
const FINAL_EID    = EID.CELO;
const DST_ADDR     = '0x8b5b3F18db50713709da94f88f9f5EEc339D1E4E';  // your EVM wallet

// Amount: 0.001 USDT (6 decimals = 1000 units)
const AMOUNT_LD  = 1000n;
const SLIPPAGE   = 990n;  // 1% slippage

// quoteSend function selector on EVM OFT
// keccak256("quoteSend((uint32,bytes32,uint256,uint256,bytes,bytes,bytes),bool)")[0:4]
const QUOTE_SEND_SEL = '0x3b6f743b';

// ── Quote leg 2 fee (Arb → Celo) via eth_call ─────────────────
/**
 * Query the Arbitrum USDT0 OFT's quoteSend to get the fee for the second hop.
 * The compose receiver on Arbitrum uses msg.value to pay this fee.
 * Returns the nativeFee in wei (as bigint).
 */
async function quoteLeg2Fee(finalEid, toAddr, amountLd, minAmountLd) {
  // ABI encode SendParam tuple manually (no ethers dependency)
  // (uint32,bytes32,uint256,uint256,bytes,bytes,bytes)
  function pad32(n) { return n.toString(16).padStart(64, '0'); }
  const tupleHead =
    pad32(finalEid) +                                        // dstEid
    toAddr.toLowerCase().replace('0x','').padStart(64,'0') + // to (bytes32)
    pad32(Number(amountLd)) +                                // amountLD
    pad32(Number(minAmountLd)) +                             // minAmountLD
    pad32(7 * 32) +                                          // extraOptions offset = 7*32=224
    pad32(7 * 32 + 32) +                                     // composeMsg offset = 256
    pad32(7 * 32 + 64) +                                     // oftCmd offset = 288
    pad32(0) +                                               // extraOptions.length = 0
    pad32(0) +                                               // composeMsg.length = 0
    pad32(0);                                                // oftCmd.length = 0

  const calldata =
    QUOTE_SEND_SEL +
    pad32(64) +      // offset to SendParam = 64
    pad32(0) +       // bool payInLzToken = false
    tupleHead;

  const res = await fetch(ARB_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'eth_call',
      params: [{ to: EVM_OFT[LEG1_DST_EID], data: calldata }, 'latest'],
    }),
  }).then(r => r.json());

  if (res.error) throw new Error(`quoteLeg2 RPC error: ${res.error.message}`);

  // Decode result: MessagingFee { nativeFee: uint256, lzTokenFee: uint256 }
  const nativeFeeHex = res.result.slice(2, 66);   // first 32 bytes
  return BigInt('0x' + nativeFeeHex);
}

// ── Main ──────────────────────────────────────
async function main() {
  const connection = new Connection(RPC, 'confirmed');
  const kp = Keypair.fromSecretKey(
    new Uint8Array(JSON.parse(readFileSync(WALLET_PATH, 'utf8'))),
  );
  console.log('Wallet:', kp.publicKey.toString());
  console.log(`\nRoute: Solana → Arbitrum (EID ${LEG1_DST_EID}) → Celo (EID ${FINAL_EID})`);

  // ── 1. Quote leg 2 fee (Arb → Celo) ─────────
  console.log('\n[1/6] Quoting leg 2 fee (Arbitrum → Celo)...');
  const leg2FeeWei = await quoteLeg2Fee(FINAL_EID, DST_ADDR, AMOUNT_LD, SLIPPAGE);
  const leg2FeeWithBuffer = leg2FeeWei * 150n / 100n;  // 50% buffer
  console.log(`  Leg 2 fee: ${leg2FeeWei} wei (${Number(leg2FeeWei)/1e18} ETH)`);
  console.log(`  With 50% buffer: ${leg2FeeWithBuffer} wei`);

  // ── 2. Build compose message (leg 2 payload) ─
  console.log('\n[2/6] Building compose message for leg 2...');
  const composeMsg = encodeComposeMsg(
    FINAL_EID,        // final destination: Celo
    DST_ADDR,         // final recipient
    SLIPPAGE,         // minAmountLD on Celo
    Buffer.alloc(0),  // no extra options for second hop
  );
  console.log(`  Compose msg (${composeMsg.length} bytes): ${composeMsg.toString('hex').slice(0, 64)}...`);

  // ── 3. Build extra_options with lzCompose ────
  // The enforced options for send_and_call only have lzReceive(200k gas).
  // We must add lzCompose(index=0, gas=500k, value=leg2FeeWithBuffer) so that:
  //   - The executor triggers the compose callback after lzReceive
  //   - The leg2FeeWithBuffer ETH is forwarded as msg.value to the compose callback
  //   - The compose receiver uses msg.value to pay the Arb→Celo LZ fee
  const extraOptions = encodeLzComposeOption(0, 500_000n, leg2FeeWithBuffer);
  console.log(`  Extra options (${extraOptions.length} bytes): ${extraOptions.toString('hex')}`);
  console.log(`  lzCompose value: ${leg2FeeWithBuffer} wei (${Number(leg2FeeWithBuffer)/1e18} ETH)`);

  // ── 4. Quote leg 1 fee (Solana → Arbitrum) ──
  console.log('\n[4/6] Quoting leg 1 fee (Solana → Arbitrum with compose)...');
  const arbOftAddr = EVM_OFT[LEG1_DST_EID];
  console.log(`  Leg 1 recipient (Arb OFT): ${arbOftAddr}`);

  const { nativeFee } = await quoteSend(
    connection, LEG1_DST_EID, arbOftAddr, AMOUNT_LD, composeMsg, kp.publicKey, extraOptions,
  );
  if (nativeFee === 0n) throw new Error('Leg 1 fee quote returned 0 — simulation may have failed.');

  const nativeFeeWithBuffer = nativeFee * 110n / 100n;
  console.log(`  Leg 1 fee: ${nativeFee} lamports (${Number(nativeFee)/1e9} SOL)`);
  console.log(`  With 10% buffer: ${nativeFeeWithBuffer} lamports`);

  // ── 5. Build accounts + instruction ─────────
  console.log('\n[5/6] Resolving accounts and building instruction...');
  const { coreAccounts, remainingAccounts, altAddress } = await buildSendAccounts(
    connection, kp.publicKey, LEG1_DST_EID,
  );

  const to32 = evmAddressTo32(arbOftAddr);
  const ixData = encodeSendParams({
    dstEid:      LEG1_DST_EID,
    to:          to32,
    amountLd:    AMOUNT_LD,
    minAmountLd: SLIPPAGE,
    extraOptions,                  // lzCompose(gas=500k, value=leg2Fee)
    composeMsg,                    // ABI-encoded (finalEid, to, minAmt, extraOptions)
    nativeFee:   nativeFeeWithBuffer,
    lzTokenFee:  0n,
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

  // ── 6. Build, simulate, send ─────────────────
  console.log('\n[6/6] Building transaction and sending...');
  let altAccount = null;
  if (altAddress) {
    const resp = await connection.getAddressLookupTable(altAddress);
    altAccount = resp.value;
    if (altAccount) console.log(`  ALT loaded: ${altAddress.toString()}`);
  }

  const { blockhash } = await connection.getLatestBlockhash();
  const msg = new TransactionMessage({
    payerKey:        kp.publicKey,
    recentBlockhash: blockhash,
    instructions:    [cuIx, prioIx, sendIx],
  }).compileToV0Message(altAccount ? [altAccount] : []);

  const tx = new VersionedTransaction(msg);
  tx.sign([kp]);

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
  console.log(`Solscan:  https://solscan.io/tx/${sig}`);
  console.log(`LZ Scan:  https://layerzeroscan.com/tx/${sig}`);
  console.log('\nExpect 2 messages on LZ Scan:');
  console.log('  1. Solana → Arbitrum (lzReceive mints tokens + sendCompose)');
  console.log('  2. Arbitrum → Celo   (compose callback calls lzSend with msg.value fee)');
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
