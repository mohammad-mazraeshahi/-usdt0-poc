// ─────────────────────────────────────────────
//  XAUT0 OFT Constants
//  Tether Gold cross-chain via LayerZero OFT V2
//
//  Key differences from USDT0:
//  1. Executable OFT program is 9zWqf5j (docs incorrectly list XWxJJE6 as "OFT Program")
//  2. OFT store is a keypair account (NOT a PDA)
//  3. Token escrow is hardcoded (NOT an ATA)
//  4. No Credits account (XAUT0 has no rate limiter)
//  5. Peer PDA seed: ["Peer", store_bytes, eid]  (USDT0 omits store_bytes)
//  6. Lock-and-mint: XAUt locked on ETH, XAUT0 minted on other chains
// ─────────────────────────────────────────────

// Actual executable OFT program (NOT XWxJJE6 — that is the store)
export const XAUT0_OFT_PROGRAM  = '9zWqf5jhauvxMc9RETXD9xbaMBrJpzPzGB6PR34Ksq6Z';

// OFT Store — keypair-created account (NOT a PDA)
export const XAUT0_OFT_STORE    = 'XWxJJE6Dq8EgdnhMWYU587f7St4HJuWbBHPstV2GtKR';

// XAUT0 SPL mint on Solana
export const XAUT0_MINT         = 'AymATz4TCL9sWNEEV9Kvyz45CHVhDZ6kUgjTJPzLpU9P';

// Token escrow — SPL token account owned by OFT store (NOT an ATA)
export const XAUT0_TOKEN_ESCROW = 'ErZSAjrxkKyMotT1NEkR98ggceMR29eRbtdku1DafWp6';

// Address Lookup Table (required — 43-account send tx exceeds size limit without it)
export const XAUT0_ALT          = 'AokBxha6VMLLgf97B5VYHEtqztamWmYERBmmFvjuTzJB';

// LayerZero infrastructure — identical to USDT0
export const PROGRAMS = {
  LZ_ENDPOINT: '76y77prsiCMvXMjuoZ5VRrhG5qYBrUMYTE5WgHqgjEn6',
  SEND_LIB:    '7a4WjyR8VZ7yZz5XJAKm39BUGn5iT9CKcv2pmG9tdXVH',
  EXECUTOR:    '6doghB248px58JSSwG4qejQ46kFMW4AMj7vzJnWZHNZn',
  DVN_LZ:      '8ahPGPjEbpgGaZx2NV1iG5Shj7TDwvsjkEDcGWjt94TP',
  DVN_2:       'HtEYV4xB4wvsj5fgTkcfuChYpvGYzgzwvNhgDZQNh7wW',
  DVN_3:       '3T7waVnx1W54ZA7XuRmXngoua4hEkRXciNL8stBJAUR4',
  // DVN_4 is required for XAUT0 but absent from USDT0 and from XAUT0 docs
  // Discovered via on-chain outbound tx analysis
  DVN_4:       '5KAALa8AEEKnW6p6AacdnqNDmGMpfhwR7AEyWs1gUvsT',
  TOKEN:       'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  SYSTEM:      '11111111111111111111111111111111',
  COMPUTE:     'ComputeBudget111111111111111111111111111111',
};

// LayerZero EIDs (same across all OFTs)
export const EID = {
  SOLANA:   30168,
  ETH:      30101,
  ARBITRUM: 30110,
  CELO:     30125,
  TRON:     30420,
  TON:      30343,
};

// XAUT0 OFT addresses on EVM chains
export const XAUT0_EVM_OFT = {
  [EID.ARBITRUM]: '0xf40542a7B66AD7C68C459EE3679635D2fDB6dF39',
  [EID.ETH]:      '0xb9c2321BB7D0Db468f570D10A424d1Cc8EFd696C', // Adapter
  [EID.CELO]:     '0x21caef8a43163eea865baee23b9c2e327696a3bf',
};

export const DECIMALS        = 6;
export const SHARED_DECIMALS = 6;
