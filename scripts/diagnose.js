#!/usr/bin/env node
// ─────────────────────────────────────────────
//  Diagnose: compute all PDAs, decode tx, verify account ordering
// ─────────────────────────────────────────────
import { Connection, PublicKey, Keypair } from '@solana/web3.js';
import { getAssociatedTokenAddress, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { readFileSync } from 'fs';
import {
  PROGRAMS, USDT0_MINT, KNOWN_ACCOUNTS, EID, EVM_OFT, SEEDS,
} from '../src/constants.js';
import {
  getOftStore, getCredits, getPeer,
  getEndpointSettings, getSendLibraryConfig, getDefaultSendLibraryConfig,
  getUlnSetting, getMessageLibInfo,
  getNonce, getEndpointEventAuthority, getOftEventAuthority,
  getUlnSendConfig, getUlnDefaultSendConfig, getSendLibraryEventAuthority,
  getExecutorConfig, getDvnConfig, getDvnLzConfig,
} from '../src/pda.js';
import { evmAddressTo32 } from '../src/borsh.js';
import bs58 from 'bs58';

const RPC = 'https://api.mainnet-beta.solana.com';
const WALLET_PATH = '/root/usdt0-poc/test-wallet.json';

// ETH example tx signature
const ETH_TX_SIG = 'PSb7a3M9vjKhgDphMRmVsoibkh3WVGtzWJNEYwfKEMcUFMrtEQo8idPeQoEFbzKdj3jrBqpASoAPETbCe6Bd5ry';

async function main() {
  const connection = new Connection(RPC, 'confirmed');
  const kp = Keypair.fromSecretKey(
    new Uint8Array(JSON.parse(readFileSync(WALLET_PATH, 'utf8'))),
  );
  const wallet = kp.publicKey;
  const DST_EID = EID.ETH;
  const DST_ADDR = '0x8b5b3F18db50713709da94f88f9f5EEc339D1E4E';

  console.log('═══════════════════════════════════════════════');
  console.log(' USDT0 POC Diagnostic');
  console.log('═══════════════════════════════════════════════');
  console.log('Wallet:', wallet.toString());

  // ── 1. Compute all PDAs ──────────────────────
  console.log('\n[1] Computing PDAs...');

  const [oftStorePda]    = getOftStore();
  const [creditsPda]     = getCredits();
  const [peerPda]        = getPeer(DST_EID);
  const [endpointPda]    = getEndpointSettings();
  const [sendLibCfg]     = getSendLibraryConfig(oftStorePda, DST_EID);
  const [defSendLibCfg]  = getDefaultSendLibraryConfig(DST_EID);
  const [oftEventAuth]   = getOftEventAuthority();
  const [epEventAuth]    = getEndpointEventAuthority();
  const [slEventAuth]    = getSendLibraryEventAuthority();
  const [ulnSendCfg]     = getUlnSendConfig(DST_EID, oftStorePda);
  const [ulnDefaultCfg]  = getUlnDefaultSendConfig(DST_EID);
  const [ulnSettingPda]  = getUlnSetting();
  const [msgLibInfo]     = getMessageLibInfo(ulnSettingPda);
  const [execCfg]        = getExecutorConfig();
  const [dvnLzCfg]       = getDvnLzConfig();
  const [dvn2Cfg]        = getDvnConfig(PROGRAMS.DVN_2);
  const [dvn3Cfg]        = getDvnConfig(PROGRAMS.DVN_3);

  // Peer address for nonce
  const peerInfo = await connection.getAccountInfo(peerPda);
  let peerAddr32 = null;
  if (peerInfo) {
    peerAddr32 = peerInfo.data.slice(8, 40);
    console.log('  Peer address from on-chain:', Buffer.from(peerAddr32).toString('hex'));
  }

  const [noncePda] = peerAddr32
    ? getNonce(oftStorePda, DST_EID, peerAddr32)
    : [null];

  const senderAta = await getAssociatedTokenAddress(
    new PublicKey(USDT0_MINT), wallet, false, TOKEN_PROGRAM_ID,
  );

  // OFT store data for token escrow + ALT
  const oftStoreInfo = await connection.getAccountInfo(oftStorePda);
  let tokenEscrow = null;
  let altAddress  = null;
  if (oftStoreInfo) {
    tokenEscrow = new PublicKey(oftStoreInfo.data.slice(8 + 32, 8 + 64));
    if (oftStoreInfo.data.length > 243 && oftStoreInfo.data[243] === 1) {
      altAddress = new PublicKey(oftStoreInfo.data.slice(244, 276));
    }
  }

  // Display all PDAs
  const pdaMap = {
    'OFT Store':              oftStorePda.toString(),
    'Credits PDA':            creditsPda.toString(),
    'Peer PDA (ETH)':         peerPda.toString(),
    'Endpoint Settings':      endpointPda.toString(),
    'SendLib Config':         sendLibCfg.toString(),
    'Def SendLib Config':     defSendLibCfg.toString(),
    'OFT Event Auth':         oftEventAuth.toString(),
    'Endpoint Event Auth':    epEventAuth.toString(),
    'SendLib Event Auth':     slEventAuth.toString(),
    'ULN Setting':            ulnSettingPda.toString(),
    'MessageLib Info':        msgLibInfo.toString(),
    'ULN Send Config':        ulnSendCfg.toString(),
    'ULN Default Config':     ulnDefaultCfg.toString(),
    'Nonce PDA':              noncePda?.toString() ?? 'N/A (no peer)',
    'Executor Config':        execCfg.toString(),
    'DVN LZ PriceFeed':       dvnLzCfg.toString(),
    'DVN 2 DvnConfig':        dvn2Cfg.toString(),
    'DVN 3 DvnConfig':        dvn3Cfg.toString(),
    'Sender ATA':             senderAta.toString(),
    'Token Escrow':           tokenEscrow?.toString() ?? 'N/A',
    'ALT (from OFT store)':   altAddress?.toString() ?? 'N/A (no ALT stored)',
  };

  for (const [k, v] of Object.entries(pdaMap)) {
    console.log(`  ${k.padEnd(24)}: ${v}`);
  }

  // ── 2. Known account comparison ──────────────
  console.log('\n[2] Comparing known values vs computed...');
  const comparisons = [
    ['OFT_STORE',       KNOWN_ACCOUNTS.OFT_STORE, oftStorePda.toString()],
    ['ULN Setting',     '2XgGZG4oP29U3w5h4nTk1V2LFHL23zKDPJjs3psGzLKQ', ulnSettingPda.toString()],
    ['MessageLibInfo',  '526PeNZfw8kSnDU4nmzJFVJzJWNhwmZykEyJr5XWz5Fv', msgLibInfo.toString()],
    ['EP Settings',     '2uk9pQh3tB5ErV7LGQJcbWjb4KeJ2UJki5qJZ8QG56G3', endpointPda.toString()],
    ['Executor Cfg',    'AwrbHeCyniXaQhiJZkLhgWdUCteeWSGaSN1sTfLiY7xK', execCfg.toString()],
    ['DVN_LZ PriceFeed','CSFsUupvJEQQd1F4SsXGACJaxQX4eropQMkGV2696eeQ', dvnLzCfg.toString()],
    ['DVN_2 DvnConfig', '4VDjp6XQaxoZf5RGwiPU9NR1EXSZn2TP4ATMmiSzLfhb', dvn2Cfg.toString()],
    ['DVN_3 DvnConfig', 'JBt34GkVns6VSoP2dCPpViW28eqE4GNgKaoZPRP63wZs', dvn3Cfg.toString()],
  ];
  for (const [name, known, computed] of comparisons) {
    const match = known === computed;
    console.log(`  ${name.padEnd(20)}: ${match ? '✅ match' : '❌ MISMATCH'}`);
    if (!match) {
      console.log(`    Known:    ${known}`);
      console.log(`    Computed: ${computed}`);
    }
  }

  // ── 3. Decode the ETH example tx ─────────────
  console.log('\n[3] Fetching example ETH tx from Solana...');
  try {
    const tx = await connection.getTransaction(ETH_TX_SIG, {
      maxSupportedTransactionVersion: 0,
      commitment: 'confirmed',
    });

    if (!tx) {
      console.warn('  TX not found (may have expired from RPC)');
    } else {
      const msg = tx.transaction.message;
      console.log('  Tx fetched OK');

      // Get all account keys (static + lookup table)
      const staticKeys = msg.staticAccountKeys.map(k => k.toString());
      const writableLut = (tx.meta?.loadedAddresses?.writable ?? []).map(k => k.toString());
      const readonlyLut = (tx.meta?.loadedAddresses?.readonly ?? []).map(k => k.toString());
      const allKeys = [...staticKeys, ...writableLut, ...readonlyLut];

      console.log(`\n  Total accounts: ${allKeys.length}`);
      console.log('  All accounts in order:');
      allKeys.forEach((k, i) => console.log(`    [${i.toString().padStart(2)}] ${k}`));

      // Find OFT send instruction
      const ixs = msg.compiledInstructions;
      const oftProgramIdx = staticKeys.indexOf(PROGRAMS.OFT);
      console.log(`\n  OFT program at static index: ${oftProgramIdx}`);

      const oftIxs = ixs.filter(ix => ix.programIdIndex === oftProgramIdx);
      console.log(`  OFT instructions found: ${oftIxs.length}`);

      for (const ix of oftIxs) {
        const disc = Buffer.from(ix.data).slice(0, 8).toString('hex');
        console.log(`\n  Instruction discriminator: ${disc}`);
        console.log(`  Account indices (${ix.accountKeyIndexes.length}):`, ix.accountKeyIndexes);
        console.log('  Mapped accounts:');
        ix.accountKeyIndexes.forEach((idx, pos) => {
          const label = allKeys[idx];
          console.log(`    [pos ${pos.toString().padStart(2)}] acct[${idx.toString().padStart(2)}] = ${label}`);
        });
      }
    }
  } catch (e) {
    console.error('  Error fetching tx:', e.message);
  }

  // ── 4. Verify on-chain balances ──────────────
  console.log('\n[4] Checking wallet balances...');
  const sol = await connection.getBalance(wallet);
  console.log(`  SOL balance: ${sol / 1e9} SOL`);

  try {
    const ataInfo = await connection.getTokenAccountBalance(senderAta);
    console.log(`  USDT0 balance: ${ataInfo.value.uiAmount} USDT0`);
  } catch {
    console.log('  USDT0 ATA not found or zero');
  }

  // ── 5. Quick quoteSend test ──────────────────
  console.log('\n[5] Running quoteSend simulation...');
  const { quoteSend } = await import('../src/quote.js');
  try {
    const result = await quoteSend(connection, DST_EID, DST_ADDR, 1000n, null, wallet);
    console.log(`  ✅ quoteSend OK: nativeFee=${result.nativeFee} lamports (${Number(result.nativeFee)/1e9} SOL)`);
  } catch (e) {
    console.error('  ❌ quoteSend failed:', e.message);
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
