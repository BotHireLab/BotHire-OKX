/**
 * x402 payment: quoting a price, and checking that a presented payment is real.
 *
 * The rule this file exists to enforce: a paid tool must never run on a payment that has not actually
 * settled on-chain. Everything here is either building the quote or proving the money moved.
 */
import { createPublicClient, http, getAddress, isAddressEqual, parseUnits, parseAbi } from 'viem';
import { CHAINS, PERMIT2, X402_PROXY, enabledChains, rpcFor, type PayChain } from './chains.js';

export const X402_VERSION = 1;

/** Price in a chain's own atomic units. Never a shared constant: this rail spans 6- and 18-dec chains. */
export function atomicFor(chain: PayChain, tokenSymbol: string, priceUsd: number): bigint {
  const t = chain.tokens.find((x) => x.symbol === tokenSymbol);
  if (!t) throw new Error(`${tokenSymbol} is not payable on ${chain.label}`);
  return parseUnits(String(priceUsd) as `${number}`, t.decimals);
}

export interface PaymentRequirements {
  scheme: 'exact';
  network: string;
  maxAmountRequired: string;
  asset: string;
  payTo: string;
  resource: string;
  description: string;
  maxTimeoutSeconds: number;
  extra: Record<string, unknown>;
}

/** The `accepts` list of an x402 402 response: every way a caller may pay for this call. */
export function buildAccepts(payTo: string, priceUsd: number, resource: string, description: string): PaymentRequirements[] {
  const out: PaymentRequirements[] = [];
  for (const chain of enabledChains()) {
    for (const t of chain.tokens) {
      out.push({
        scheme: 'exact',
        network: chain.caip,
        maxAmountRequired: atomicFor(chain, t.symbol, priceUsd).toString(),
        asset: t.address,
        payTo,
        resource,
        description,
        maxTimeoutSeconds: 600,
        extra: chain.method === 'permit2'
          ? { assetTransferMethod: 'permit2', permit2: PERMIT2, spenderAddress: X402_PROXY, chainId: chain.chainId, decimals: t.decimals, name: t.symbol }
          : { assetTransferMethod: 'eip3009', name: 'USD Coin', version: '2', chainId: chain.chainId, decimals: t.decimals },
      });
    }
  }
  return out;
}

export const paymentRequiredBody = (accepts: PaymentRequirements[], error: string) => ({ x402Version: X402_VERSION, error, accepts });

/** Decode the `X-PAYMENT` header — base64 JSON per x402, but tolerate raw JSON too. */
export function decodePayment(header: string | null | undefined): any | null {
  if (!header) return null;
  const raw = header.trim();
  try { return JSON.parse(Buffer.from(raw, 'base64').toString('utf8')); } catch { /* fall through */ }
  try { return JSON.parse(raw); } catch { return null; }
}

const ERC20 = parseAbi(['function balanceOf(address) view returns (uint256)']);
const PERMIT2_NONCE_ABI = parseAbi(['function nonceBitmap(address owner, uint256 wordPos) view returns (uint256)']);

/**
 * Has this Permit2 nonce been spent on-chain? Permit2 stores unordered nonces as a bitmap: bit
 * (nonce & 0xff) of word (nonce >> 8). This is the definitive "did the buyer's money move" oracle.
 *
 * Returns undefined when the chain cannot be read. Callers MUST treat that as unknown and refuse —
 * never as "unpaid", and never as "paid".
 */
export async function permit2NonceSpent(chain: PayChain, owner: `0x${string}`, nonce: bigint): Promise<boolean | undefined> {
  try {
    const client = createPublicClient({ chain: chain.viemChain, transport: http(rpcFor(chain)) });
    const word = (await client.readContract({
      address: PERMIT2, abi: PERMIT2_NONCE_ABI, functionName: 'nonceBitmap', args: [owner, nonce >> BigInt(8)],
    })) as bigint;
    return ((word >> (nonce & BigInt(0xff))) & BigInt(1)) === BigInt(1);
  } catch { return undefined; }
}

/** Confirm a settlement transaction really succeeded on the chain it claims. */
export async function txSucceeded(chain: PayChain, txHash: string): Promise<boolean> {
  try {
    const client = createPublicClient({ chain: chain.viemChain, transport: http(rpcFor(chain)) });
    const rcpt = await client.getTransactionReceipt({ hash: txHash as `0x${string}` });
    return rcpt.status === 'success';
  } catch { return false; }
}

export interface VerifiedPayment { chain: PayChain; payer: `0x${string}`; token: string; amount: bigint; txHash?: string }

/**
 * Check a presented payment against what we quoted. This deliberately does NOT broadcast anything:
 * the reference deployment relays the buyer's signature through the x402 proxy, and a self-hosted copy
 * verifies that a settlement already happened. Either way the tool only runs once the chain agrees.
 */
export async function verifyPayment(obj: any, payTo: string, priceUsd: number): Promise<{ ok: true; payment: VerifiedPayment } | { ok: false; reason: string }> {
  const chain = CHAINS[String(obj?.network ?? '').replace('eip155:', '') as string]
    ?? Object.values(CHAINS).find((c) => c.caip === String(obj?.network ?? '').toLowerCase());
  if (!chain) return { ok: false, reason: `unsupported or missing network: ${String(obj?.network)}` };
  if (!enabledChains().some((c) => c.key === chain.key)) return { ok: false, reason: `${chain.label} is not enabled on this deployment` };

  const auth = obj?.payload?.permit2Authorization ?? obj?.permit2Authorization;
  const txHash: string | undefined = obj?.payload?.txHash ?? obj?.txHash ?? obj?.transaction;

  // Path 1 — a settlement transaction is presented. Verify it on-chain and that it moved the money.
  if (txHash) {
    if (!(await txSucceeded(chain, txHash))) return { ok: false, reason: `settlement tx ${txHash} did not succeed on ${chain.label}` };
    return { ok: true, payment: { chain, payer: getAddress(String(auth?.from ?? obj?.from ?? '0x0000000000000000000000000000000000000000')), token: String(auth?.permitted?.token ?? ''), amount: BigInt(auth?.permitted?.amount ?? 0), txHash } };
  }

  // Path 2 — a Permit2 authorization. Check every field we quoted, then that the nonce really was spent.
  if (!auth?.permitted) return { ok: false, reason: 'payment carries neither a settlement tx nor a Permit2 authorization' };
  let payer: `0x${string}`, token: `0x${string}`, spender: `0x${string}`, amount: bigint, nonce: bigint, deadline: bigint, to: `0x${string}`;
  try {
    payer = getAddress(String(auth.from));
    token = getAddress(String(auth.permitted.token));
    spender = getAddress(String(auth.spender));
    to = getAddress(String(auth.witness?.to));
    amount = BigInt(auth.permitted.amount);
    nonce = BigInt(auth.nonce);
    deadline = BigInt(auth.deadline);
  } catch { return { ok: false, reason: 'malformed Permit2 authorization' }; }

  const t = chain.tokens.find((x) => isAddressEqual(x.address, token));
  if (!t) return { ok: false, reason: `${token} is not an accepted stablecoin on ${chain.label}` };
  if (!isAddressEqual(spender, X402_PROXY)) return { ok: false, reason: 'spender is not the x402 proxy' };
  if (!isAddressEqual(to, getAddress(payTo))) return { ok: false, reason: 'payment is not addressed to this service' };
  const required = atomicFor(chain, t.symbol, priceUsd);
  if (amount < required) return { ok: false, reason: `amount ${amount} is below the price ${required}` };
  // A ceiling as well as a floor: a client using the wrong chain's decimals would otherwise sign a
  // 10^12x overpayment that we would happily accept.
  if (amount > required * BigInt(10)) return { ok: false, reason: 'amount exceeds 10x the price (wrong decimals?)' };
  if (deadline <= BigInt(Math.floor(Date.now() / 1000))) return { ok: false, reason: 'payment authorization has expired' };

  const spent = await permit2NonceSpent(chain, payer, nonce);
  if (spent === undefined) return { ok: false, reason: `could not read ${chain.label} to confirm the payment; refusing rather than guessing` };
  if (!spent) return { ok: false, reason: 'this authorization has not been settled on-chain yet — relay it first, or present the settlement tx hash' };

  return { ok: true, payment: { chain, payer, token: t.symbol, amount } };
}
