/**
 * The MCP surface: one free tool that quotes the price, one paid tool that does real work.
 *
 * This is the A2MCP shape OKX asks of an Agent Service Provider — a standardized endpoint with fixed
 * per-call pricing, where the endpoint is "either free, or x402-compliant with payment support".
 */
import { buildAccepts, decodePayment, paymentRequiredBody, verifyPayment } from './x402.js';
import { enabledChains } from './chains.js';

const BOTHIRE_API = (process.env.BOTHIRE_API_BASE || 'https://www.bothire.io').replace(/\/$/, '');
export const PRICE_USD = (() => { const n = Number(process.env.PRICE_USD); return Number.isFinite(n) && n > 0 ? n : 0.05; })();
export const PAYEE = (process.env.PAYEE_ADDRESS || '').trim();

export const PROTOCOL_VERSION = '2025-06-18';
const SUPPORTED = new Set(['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']);
const SERVER_INFO = { name: 'bothire-okx', title: 'BotHire for OKX AI', version: '1.0.0' };

const S = (props: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties: props, required, additionalProperties: false });

const TOOLS = [
  {
    name: 'get_pricing',
    title: 'What this service costs (free)',
    description: 'The per-call price and the chains and stablecoins this service accepts. Free to call.',
    annotations: { readOnlyHint: true },
    inputSchema: S({}),
  },
  {
    name: 'find_agent_for_task',
    title: 'Find the right AI agent for a task (paid, per call)',
    description:
      'Describe a job in plain language; get back a ranked shortlist of AI agents on BotHire that can do it — ' +
      'each with live price, trust score, completed hires, provider wallet, and a ready-to-use hire plan. ' +
      'Searches live marketplace supply, not a static index. Paid per call: the first call without payment ' +
      'returns x402 payment requirements.',
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: S({
      task: { type: 'string', description: 'What needs doing, e.g. "turn this script into a 30s avatar video".' },
      max_price_usdc: { type: 'number', description: 'Optional budget ceiling per hire.' },
      limit: { type: 'number', description: 'Candidates to return (default 5, max 10).' },
    }, ['task']),
  },
] as const;
const PAID = new Set<string>(['find_agent_for_task']);

const text = (payload: unknown, isError = false) => ({
  content: [{ type: 'text', text: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2) }],
  ...(isError ? { isError: true } : {}),
});

/** The actual paid work: rank live BotHire supply against a plain-language task. */
async function findAgentForTask(args: Record<string, any>) {
  const task = String(args.task || '').trim();
  if (!task) return text('task is required — describe the job in plain language.', true);
  const limit = Math.min(Math.max(Math.floor(Number(args.limit) || 5), 1), 10);
  const maxPrice = Number(args.max_price_usdc);

  const q = new URLSearchParams({ q: task, limit: '30' });
  if (Number.isFinite(maxPrice) && maxPrice > 0) q.set('max_price', String(maxPrice));
  const res = await fetch(`${BOTHIRE_API}/api/skills/search?${q}`, { headers: { accept: 'application/json' } });
  const body: any = await res.json().catch(() => ({}));
  const skills: any[] = body?.skills ?? body?.results ?? [];

  const ranked = skills.map((s) => {
    const hires = Number(s.hire_count ?? 0);
    const trust = Number(s.trust_score ?? s.bot_trust_score ?? 0);
    const rating = Number(s.rating ?? 0);
    // Explainable on purpose: proven delivery first, then reputation, then price.
    const score = hires * 3 + trust / 10 + rating * 4 - Math.min(Number(s.price_usdc) || 0, 50) / 10;
    return {
      skill_id: s._id ?? s.id,
      title: s.name ?? s.title,
      provider: s.bot_name ?? s.bot_id,
      price_usdc: s.price_usdc,
      price_type: s.price_type,
      trust_score: trust || null,
      completed_hires: hires || null,
      url: `${BOTHIRE_API}/skill/${s._id ?? s.id}`,
      how_to_hire: `POST ${BOTHIRE_API}/api/hires { "post_id": "${s._id ?? s.id}" } then pay the returned payment_required (gasless on Base, Arbitrum, BNB Chain and X Layer).`,
      _score: score,
    };
  }).sort((a, b) => b._score - a._score).slice(0, limit).map(({ _score, ...r }) => r);

  return text({
    task,
    candidates_found: skills.length,
    returned: ranked.length,
    ranked_by: 'completed hires, then trust and rating, then price',
    candidates: ranked,
    note: ranked.length ? undefined : 'No live listing matched. Try broader wording, or post it as an open need on BotHire.',
  });
}

export interface RpcOutcome { body: any | null; status?: number; headers?: Record<string, string> }

export async function handleRpc(msg: any, xPaymentHeader: string | null, resourceUrl: string): Promise<RpcOutcome> {
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return { body: { jsonrpc: '2.0', id: msg?.id ?? null, error: { code: -32600, message: 'Invalid Request' } } };
  }
  const id = msg.id ?? null;
  const isNotification = msg.id === undefined;
  const ok = (result: unknown) => ({ jsonrpc: '2.0', id, result });
  const err = (code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } });

  switch (msg.method) {
    case 'initialize':
      return { body: ok({
        protocolVersion: SUPPORTED.has(msg.params?.protocolVersion) ? msg.params.protocolVersion : PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: `BotHire's paid agent-matching service for OKX AI. get_pricing is free. Calling a paid tool without payment returns HTTP 402 and x402 payment requirements; pay one and retry with an X-PAYMENT header. Price: $${PRICE_USD} per call.`,
      }) };
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return { body: null };
    case 'ping':
      return { body: isNotification ? null : ok({}) };
    case 'tools/list':
      return { body: ok({ tools: TOOLS }) };
    case 'tools/call': {
      const name = msg.params?.name;
      const args = (msg.params?.arguments ?? {}) as Record<string, any>;
      if (typeof name !== 'string') return { body: err(-32602, 'Invalid params: name is required') };

      if (name === 'get_pricing') {
        return { body: ok(text({
          price_usd_per_call: PRICE_USD,
          paid_tools: [...PAID],
          accepts: PAYEE ? buildAccepts(PAYEE, PRICE_USD, resourceUrl, 'BotHire paid MCP call').map((a) => ({ network: a.network, asset: a.asset, amount: a.maxAmountRequired, method: (a.extra as any).assetTransferMethod })) : [],
          chains_enabled: enabledChains().map((c) => c.label),
          configured: Boolean(PAYEE),
          how: 'Call a paid tool with no X-PAYMENT to get HTTP 402 + accepts. Pay one, then retry with X-PAYMENT.',
        }, !PAYEE)) };
      }
      if (!PAID.has(name)) return { body: err(-32602, `Unknown tool: ${name}`) };

      // Never invent a payee. With none configured the service refuses to sell rather than take money
      // to an address nobody chose.
      if (!PAYEE) return { body: ok(text('This service is not accepting payments yet (PAYEE_ADDRESS is unset).', true)) };

      const payment = decodePayment(xPaymentHeader);
      if (!payment) {
        return {
          body: { ...paymentRequiredBody(buildAccepts(PAYEE, PRICE_USD, resourceUrl, `BotHire: ${name}`), `Payment required: $${PRICE_USD} per call to ${name}.`), tool: name },
          status: 402,
        };
      }

      const verdict = await verifyPayment(payment, PAYEE, PRICE_USD);
      if (!verdict.ok) {
        return {
          body: { ...paymentRequiredBody(buildAccepts(PAYEE, PRICE_USD, resourceUrl, `BotHire: ${name}`), `Payment rejected: ${verdict.reason}`), tool: name },
          status: 402,
        };
      }

      const result = await findAgentForTask(args);
      const receipt = { paid_usd: PRICE_USD, chain: verdict.payment.chain.label, network: verdict.payment.chain.caip, payer: verdict.payment.payer, settlement_tx: verdict.payment.txHash ?? null };
      return {
        body: ok({ ...result, content: [...result.content, { type: 'text', text: JSON.stringify({ payment_receipt: receipt }, null, 2) }] }),
        headers: { 'x-payment-response': Buffer.from(JSON.stringify({ success: true, network: verdict.payment.chain.caip, transaction: verdict.payment.txHash ?? null })).toString('base64') },
      };
    }
    default:
      return { body: isNotification ? null : err(-32601, `Method not found: ${msg.method}`) };
  }
}

export { SUPPORTED as SUPPORTED_PROTOCOLS, SERVER_INFO, TOOLS };
