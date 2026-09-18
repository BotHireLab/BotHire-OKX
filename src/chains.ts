/**
 * The chains this service can be paid on.
 *
 * X Layer is the one that matters for OKX: it is OKX's own zkEVM, and it is where an OKX-side agent
 * already holds funds. Every address below was read off the live chains, not copied from a blog post —
 * see `npm run verify` output in the README.
 */
import { base, arbitrum, bsc, xLayer } from 'viem/chains';
import type { Chain } from 'viem';

/** Uniswap's Permit2 singleton. Same address on every EVM chain, including X Layer. */
export const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3' as const;
/** BotHire's x402 settlement proxy. Deployed at the same address on every chain here; its runtime
 *  bytecode on X Layer is byte-identical to Base/Arbitrum/BNB, so it is the same contract, not a
 *  look-alike squatting a predictable address. */
export const X402_PROXY = '0x402085c248EeA27D92E8b30b2C58ed07f9E20001' as const;

export interface PayChain {
  key: string;
  label: string;
  caip: string;
  chainId: number;
  viemChain: Chain;
  rpcEnv: string;
  rpcDefault: string;
  /** Stablecoins payable on this chain, with their decimals. */
  tokens: { symbol: string; address: `0x${string}`; decimals: number }[];
  /** How a payment settles here. Permit2 = our relayer broadcasts the buyer's signature and pays gas. */
  method: 'permit2' | 'eip3009';
}

export const CHAINS: Record<string, PayChain> = {
  xlayer: {
    key: 'xlayer', label: 'X Layer', caip: 'eip155:196', chainId: 196, viemChain: xLayer,
    rpcEnv: 'XLAYER_RPC_URL', rpcDefault: 'https://rpc.xlayer.tech',
    // Both of X Layer's stablecoins are 6-decimal. USDT is the liquid one — the bridged USDC has no
    // practical route in, which is why the live demo pays in USDT.
    tokens: [
      { symbol: 'USDT', address: '0x1E4a5963aBFD975d8c9021ce480b42188849D41d', decimals: 6 },
      { symbol: 'USDC', address: '0x74b7F16337b8972027F6196A17a631aC6dE26d22', decimals: 6 },
    ],
    method: 'permit2',
  },
  base: {
    key: 'base', label: 'Base', caip: 'eip155:8453', chainId: 8453, viemChain: base,
    rpcEnv: 'BASE_RPC_URL', rpcDefault: 'https://mainnet.base.org',
    tokens: [{ symbol: 'USDC', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 }],
    method: 'eip3009',
  },
  arbitrum: {
    key: 'arbitrum', label: 'Arbitrum', caip: 'eip155:42161', chainId: 42161, viemChain: arbitrum,
    rpcEnv: 'ARBITRUM_RPC_URL', rpcDefault: 'https://arb1.arbitrum.io/rpc',
    tokens: [{ symbol: 'USDC', address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6 }],
    method: 'eip3009',
  },
  bsc: {
    key: 'bsc', label: 'BNB Chain', caip: 'eip155:56', chainId: 56, viemChain: bsc,
    rpcEnv: 'BSC_RPC_URL', rpcDefault: 'https://bsc-dataseed.bnbchain.org',
    // Note the 18 decimals here — this rail spans 6- and 18-decimal chains, which is why amounts are
    // always computed from the chain's own decimals and never from a shared constant.
    tokens: [
      { symbol: 'USDT', address: '0x55d398326f99059fF775485246999027B3197955', decimals: 18 },
      { symbol: 'USDC', address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', decimals: 18 },
    ],
    method: 'permit2',
  },
};

export const chainByCaip = (caip: unknown): PayChain | undefined =>
  typeof caip === 'string' ? Object.values(CHAINS).find((c) => c.caip === caip.trim().toLowerCase()) : undefined;

export const rpcFor = (c: PayChain): string => process.env[c.rpcEnv] || c.rpcDefault;

/** Chains this deployment will quote. Defaults to X Layer only — the OKX track's chain. */
export function enabledChains(): PayChain[] {
  const raw = (process.env.PAY_CHAINS || 'xlayer').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const out = raw.map((k) => CHAINS[k]).filter(Boolean);
  return out.length ? out : [CHAINS.xlayer];
}
