#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
//  USDT0 OFT — Send from Solana to a NATIVE USDT0 OFT chain (Berachain)
//
//  Native USDT0 OFT chains (Berachain, Optimism, Polygon, etc.) are NOT
//  directly peered with Solana. The routing is:
//
//    Solana → OLD Arb OFT (leg 1, with composeMsg)
//               ↓ lzCompose triggers ADAPTIVE_BRIDGE_ARB
//    ADAPTIVE_BRIDGE_ARB → NEW Arb OFT → Berachain (leg 2)
//
//  Key contracts on Arbitrum:
//    OLD_ARB_OFT (0x77652d5A...)  — Legacy Mesh hub, has Solana peer
//    ADAPTIVE_BRIDGE (0x759BA420...) — compose receiver; bridges to native chains
//    NEW_ARB_OFT (0x14E4A1B1...)  — native OFT proxy, has Berachain peer
//
//  The lzCompose option in extraOptions carries ETH as msg.value to the
//  ADAPTIVE_BRIDGE, which uses it to pay the NEW_ARB_OFT leg 2 fee.
//
//  Verified via example tx:
//    JUjUi5NiajNJCqqwQTA75R1Mz14BmBUJTwXK77HXyZ2FjmEawqfKV3zZ8ENCFjWNehd2QVhQZoMtgirLnhgTAee
// ═══════════════════════════════════════════════════════════════
import {
  Connection, Keypair, PublicKey,
  TransactionMessage, VersionedTransaction,
  TransactionInstruction, ComputeBudgetProgram,
} from '@solana/web3.js';
import { ethers } from 'ethers';
import { readFileSync } from 'fs';
import { EID, EVM_OFT, NEW_ARB_OFT, ADAPTIVE_BRIDGE_ARB, PROGRAMS } from '../src/constants.js';
import { encodeSendParams, evmAddressTo32, encodeComposeMsg, encodeLzComposeOption, encodeLzNativeDropOption } from '../src/borsh.js';
import { buildSendAccounts } from '../src/accounts.js';
import { quoteSend } from '../src/quote.js';
import { getOftEventAuthority } from '../src/pda.js';

// ── Config ────────────────────────────────────
const RPC         = 'https://api.mainnet-beta.solana.com';
const ARB_RPC     = 'https://arb1.arbitrum.io/rpc';
const WALLET_PATH = '/root/usdt0-poc/test-wallet.json';

// Route: Solana → OLD Arb OFT → ADAPTIVE_BRIDGE → NEW Arb OFT → Berachain
const LEG1_DST_EID = EID.ARBITRUM;
const FINAL_EID    = EID.BERACHAIN;
const DST_ADDR     = '0x8b5b3F18db50713709da94f88f9f5EEc339D1E4E';  // your EVM wallet

// Amount: 0.001 USDT (6 decimals = 1000 units)
const AMOUNT_LD  = 1000n;
const SLIPPAGE   = 990n;  // 1% slippage

// ── ABI fragments for NEW Arb OFT ────────────
const OFT_ABI = [
  'function quoteSend((uint32 dstEid, bytes32 to, uint256 amountLD, uint256 minAmountLD, bytes extraOptions, bytes composeMsg, bytes oftCmd) sendParam, bool payInLzToken) view returns (uint256 nativeFee, uint256 lzTokenFee)',
];

// ── Quote leg 2 fee (NEW Arb OFT → Berachain) ─
/**
 * Query the NEW Arbitrum USDT0 OFT's quoteSend to get the fee for leg 2.
 * The ADAPTIVE_BRIDGE on Arbitrum uses msg.value (= this fee) to pay for leg 2.
 *
 * @param {number} finalEid     - destination EID (e.g. Berachain 30362)
 * @param {string} toAddr       - recipient address
 * @param {bigint} amountLd     - token amount
 * @param {bigint} minAmountLd  - min token amount
 * @param {Buffer} extraOptions - LZ options for leg 2 (native drop etc)
 * @returns {Promise<bigint>}   - nativeFee in wei
 */
async function quoteLeg2Fee(finalEid, toAddr, amountLd, minAmountLd, extraOptions = Buffer.alloc(0)) {
  const provider = new ethers.JsonRpcProvider(ARB_RPC);
  const oft      = new ethers.Contract(NEW_ARB_OFT, OFT_ABI, provider);

  const sendParam = {
    dstEid:       finalEid,
    to:           ethers.zeroPadValue(toAddr, 32),
    amountLD:     amountLd,
    minAmountLD:  minAmountLd,
    extraOptions: '0x' + extraOptions.toString('hex'),
    composeMsg:   '0x',
    oftCmd:       '0x',
  };

  const [nativeFee] = await oft.quoteSend(sendParam, false);
  return nativeFee;
}

// ── Main ──────────────────────────────────────
async function main() {
  const connection = new Connection(RPC, 'confirmed');
  const kp = Keypair.fromSecretKey(
    new Uint8Array(JSON.parse(readFileSync(WALLET_PATH, 'utf8'))),
  );
  console.log('Wallet:', kp.publicKey.toString());
  console.log(`\nRoute: Solana → ARB (EID ${LEG1_DST_EID}) → Berachain (EID ${FINAL_EID})`);
  console.log(`  Leg 1 → to: ${ADAPTIVE_BRIDGE_ARB}  (USDT0 Adaptive Bridge)`);
  console.log(`  Leg 2 from: ${NEW_ARB_OFT}  (NEW Arb OFT)`);

  // ── 1. Build leg 2 extra options (native drop for Berachain gas) ──
  // A small native drop gives the recipient a tiny bit of BERA for gas.
  // Amount from example tx: 3_800_000 wei (≈ 0.0000038 BERA)
  // Use 0 to skip, or a small value to match example.
  const leg2ExtraOptions = encodeLzNativeDropOption(3_800_000n, DST_ADDR);
  console.log(`\n[1/6] Leg 2 extra options (native drop): ${leg2ExtraOptions.toString('hex')}`);

  // ── 2. Quote leg 2 fee (NEW Arb OFT → Berachain) ────────────────
  console.log('\n[2/6] Quoting leg 2 fee (NEW Arb OFT → Berachain)...');
  const leg2FeeWei = await quoteLeg2Fee(FINAL_EID, DST_ADDR, AMOUNT_LD, SLIPPAGE, leg2ExtraOptions);
  const leg2FeeWithBuffer = leg2FeeWei * 150n / 100n;  // 50% buffer
  console.log(`  Leg 2 fee: ${leg2FeeWei} wei (${Number(leg2FeeWei)/1e18} ETH)`);
  console.log(`  With 50% buffer: ${leg2FeeWithBuffer} wei`);

  if (leg2FeeWei === 0n) {
    throw new Error('Leg 2 fee quote returned 0 — quoteSend call may have failed');
  }

  // ── 3. Build compose message (full ABI-encoded SendParam for leg 2) ─
  console.log('\n[3/6] Building compose message (SendParam for Arb→Berachain)...');
  const composeMsg = encodeComposeMsg(
    FINAL_EID,          // dstEid: Berachain (30362)
    DST_ADDR,           // to: recipient on Berachain
    AMOUNT_LD,          // amountLD
    SLIPPAGE,           // minAmountLD
    leg2ExtraOptions,   // extraOptions: native drop for Berachain gas
  );
  console.log(`  Compose msg (${composeMsg.length} bytes): ${composeMsg.toString('hex').slice(0, 64)}...`);

  // ── 4. Build extra_options for leg 1 (lzCompose with fee) ────────
  // lzCompose(index=0, gas=500k, value=leg2FeeWithBuffer):
  //   - gas: executor gas for the compose callback on Arbitrum
  //   - value: ETH forwarded as msg.value to ADAPTIVE_BRIDGE's lzCompose
  //            which uses it to pay the NEW Arb OFT's leg 2 fee
  const leg1ExtraOptions = encodeLzComposeOption(0, 500_000n, leg2FeeWithBuffer);
  console.log(`\n[4/6] Leg 1 extra options (${leg1ExtraOptions.length} bytes): ${leg1ExtraOptions.toString('hex')}`);
  console.log(`  lzCompose value: ${leg2FeeWithBuffer} wei (${Number(leg2FeeWithBuffer)/1e18} ETH)`);

  // ── 5. Quote leg 1 fee (Solana → OLD Arb OFT with compose) ──────
  console.log('\n[5/6] Quoting leg 1 fee (Solana → Arb with compose)...');
  // The recipient on Arbitrum is the ADAPTIVE_BRIDGE, not the OFT itself
  const { nativeFee } = await quoteSend(
    connection, LEG1_DST_EID, ADAPTIVE_BRIDGE_ARB, AMOUNT_LD, composeMsg, kp.publicKey, leg1ExtraOptions,
  );
  if (nativeFee === 0n) throw new Error('Leg 1 fee quote returned 0 — simulation may have failed.');

  const nativeFeeWithBuffer = nativeFee * 110n / 100n;
  console.log(`  Leg 1 fee: ${nativeFee} lamports (${Number(nativeFee)/1e9} SOL)`);
  console.log(`  With 10% buffer: ${nativeFeeWithBuffer} lamports`);

  // ── 6. Build accounts + instruction ─────────────────────────────
  console.log('\n[6/6] Resolving accounts and building instruction...');
  const { coreAccounts, remainingAccounts, altAddress } = await buildSendAccounts(
    connection, kp.publicKey, LEG1_DST_EID,
  );

  // to = ADAPTIVE_BRIDGE (tokens mint there, lzCompose called on it)
  const to32 = evmAddressTo32(ADAPTIVE_BRIDGE_ARB);
  const ixData = encodeSendParams({
    dstEid:      LEG1_DST_EID,
    to:          to32,
    amountLd:    AMOUNT_LD,
    minAmountLd: SLIPPAGE,
    extraOptions: leg1ExtraOptions,  // lzCompose(gas=500k, value=leg2Fee)
    composeMsg,                      // full ABI-encoded SendParam for leg 2
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

  // Build, simulate, send
  console.log('\nBuilding and simulating transaction...');
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
  console.log('  1. Solana → Arbitrum (lzReceive mints to ADAPTIVE_BRIDGE + sendCompose)');
  console.log('  2. Arbitrum (via NEW_ARB_OFT) → Berachain (compose callback sends leg 2)');
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
