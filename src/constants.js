// ─────────────────────────────────────────────
//  USDT0 OFT POC — Constants
// ─────────────────────────────────────────────

export const PROGRAMS = {
  OFT:          'Fuww9mfc8ntAwxPUzFia7VJFAdvLppyZwhPJoXySZXf7',
  LZ_ENDPOINT:  '76y77prsiCMvXMjuoZ5VRrhG5qYBrUMYTE5WgHqgjEn6',
  SEND_LIB:     '7a4WjyR8VZ7yZz5XJAKm39BUGn5iT9CKcv2pmG9tdXVH',
  EXECUTOR:     '6doghB248px58JSSwG4qejQ46kFMW4AMj7vzJnWZHNZn',
  // DVN_LZ: LZ price-feed oracle DVN. Config is PDA(["PriceFeed"], DVN_LZ) — READONLY
  DVN_LZ:       '8ahPGPjEbpgGaZx2NV1iG5Shj7TDwvsjkEDcGWjt94TP',
  // DVN_2: secondary DVN. Config is PDA(["DvnConfig"], DVN_2) — WRITABLE
  DVN_2:        'HtEYV4xB4wvsj5fgTkcfuChYpvGYzgzwvNhgDZQNh7wW',
  // DVN_3: third DVN (optional). Config is PDA(["DvnConfig"], DVN_3) — WRITABLE
  DVN_3:        '3T7waVnx1W54ZA7XuRmXngoua4hEkRXciNL8stBJAUR4',
  TOKEN:        'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  SYSTEM:       '11111111111111111111111111111111',
  COMPUTE:      'ComputeBudget111111111111111111111111111111',
};

// USDT0 mint on Solana (= classic USDT SPL token)
export const USDT0_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';

// Known fixed PDAs (from on-chain state, same for everyone)
export const KNOWN_ACCOUNTS = {
  OFT_STORE:    'HyXJcgYpURfDhgzuyRL7zxP4FhLg7LZQMeDrR4MXZcMN',
  TOKEN_ESCROW: 'AwrbHeCyniXaQhiJZkLhgWdUCteeWSGaSN1sTfLiY7xK',
  CREDITS:      '6trV82jqtcqrsMd5ZXKvR6QzLX6bHstBK4wZFx1qrffC',
  // LZ Endpoint PDA
  ENDPOINT_PDA: 'B981t4zrZf3HCgtFFcw32D7Ukoa6saGMomeJcYNRwsQd',
  // Nonce account for OFT store
  NONCE:        'JBt34GkVns6VSoP2dCPpViW28eqE4GNgKaoZPRP63wZs',
};

// LayerZero chain endpoint IDs
export const EID = {
  SOLANA:   30168,
  ETH:      30101,
  ARBITRUM: 30110,
  CELO:     30125,
  TRON:     30420,
  TON:      30343,
  BERACHAIN: 30362,
};

// USDT0 OFT addresses on EVM chains
// There are TWO Arbitrum OFTs:
//   OLD_ARB_OFT: 0x77652d5A... — Legacy Mesh hub (peers: ETH, Solana, Celo, TON, Tron)
//   NEW_ARB_OFT: 0x14E4A1B1... — Native OFT proxy (peers: Berachain, Optimism, Polygon, etc.)
//
// Adaptive routing (Solana → native USDT0 OFT chains) path:
//   Solana → OLD_ARB_OFT (leg 1, with composeMsg)
//            ↓ lzCompose on ADAPTIVE_BRIDGE_ARB
//   ADAPTIVE_BRIDGE_ARB → NEW_ARB_OFT → Berachain/etc (leg 2)
export const EVM_OFT = {
  [EID.ETH]:       '0x6c96dE32CEa08842dcc4058c14d3aaAD7Fa41ef',
  [EID.ARBITRUM]:  '0x77652d5Aba086137b595875263Fc200182919B92',  // OLD ARB OFT (Legacy Mesh)
  [EID.CELO]:      '0xf10e161027410128e63e75d0200fb6d34b2db243',
  [EID.BERACHAIN]: '0x3dc96399109df5ceb2c226664a086140bd0379cb',  // verified from LZ Scan
};

// NEW Arbitrum OFT — connects to native USDT0 OFT chains (Berachain, Optimism, etc.)
// Used for quoting leg 2 fee (Arb → Berachain)
export const NEW_ARB_OFT = '0x14E4A1B13bf7F943c8ff7C51fb60FA964A298D92';

// USDT0 Adaptive Bridge on Arbitrum
// This contract is the compose receiver for adaptive sends.
// Leg 1 sends to this address (it receives tokens + lzCompose is called on it).
// Its lzCompose handler decodes the SendParam and forwards via NEW_ARB_OFT.
// Verified from on-chain: example tx JUjUi5... used this address.
export const ADAPTIVE_BRIDGE_ARB = '0x759BA420bF1ded1765F18C2DC3Fc57A1964A2Ad1';

// USDT0 decimals = 6
export const DECIMALS = 6;
export const SHARED_DECIMALS = 6;

// Seeds (as Buffers for PDA derivation)
export const SEEDS = {
  OFT:     Buffer.from('OFT'),
  PEER:    Buffer.from('Peer'),
  CREDITS: Buffer.from('Credits'),
};
