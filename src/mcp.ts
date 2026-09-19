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
      'Describe a job in plain language; get back a ranked shortlist of hireable BotHire listings — each ' +
      'with live price, completed-hire count, how many of your keywords it matched, and the exact call to ' +
      'hire it. Searches live marketplace supply, not a static index. Paid per call, and if nothing ' +
      'matches you are told so and NOT charged. The first call without payment returns x402 requirements.',
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

/** Words too common to narrow anything down. */
const STOPWORDS = new Set(('a an and are as at be by can could do does for from get give go has have how i in into is it just make me my need of on or please that the then this to turn up us use want was we what when where which who will with would your').split(' '));

/**
 * Find hireable listings for a plain-language task.
 *
 * Two things learned the expensive way, by running this with real money:
 *  - hires resolve against POSTS. Skill-search entries are a different collection whose ids cannot be
 *    hired, so recommending them hands the caller instructions that fail.
 *  - `?q=` is a literal substring regex over title and description, so a whole sentence matches nothing.
 *    "turn a short script into a 30 second avatar video" returned zero; "avatar video" returned five.
 *    So: strip filler words, query the distinctive ones separately, merge, and rank by keyword hits.
 */
export async function searchHireablePosts(task: string, ceilingUsdc: number, limit = 5): Promise<any[]> {
  const words = String(task || '').toLowerCase().match(/[a-z0-9][a-z0-9+.-]{2,}/g) || [];
  const keywords = [...new Set(words.filter((w) => !STOPWORDS.has(w)))].slice(0, 5);
  const queries = keywords.length ? keywords : [''];

  const byId = new Map<string, { post: any; hits: number }>();
  await Promise.all(queries.map(async (kw) => {
    const q = new URLSearchParams({ limit: '20' });
    if (kw) q.set('q', kw);
    try {
      const r = await fetch(`${BOTHIRE_API}/api/posts?${q}`, { headers: { accept: 'application/json' } });
      const b: any = await r.json().catch(() => ({}));
      for (const p of (b?.posts ?? b?.items ?? b?.results ?? [])) {
        const id = p?._id; if (!id) continue;
        const prev = byId.get(id);
        if (prev) prev.hits += 1; else byId.set(id, { post: p, hits: 1 });
      }
    } catch { /* one keyword failing must not sink the search */ }
  }));

  const affordable = [...byId.values()].filter(({ post }) => {
    const price = Number(post.price_usdc);
    return Number.isFinite(price) && price > 0 && price <= ceilingUsdc;
  });
  affordable.sort((a, b) =>
    (b.hits - a.hits)
    || (Number(b.post.hires_count || 0) - Number(a.post.hires_count || 0))
    || (Number(a.post.price_usdc) - Number(b.post.price_usdc)));
  return affordable.slice(0, limit).map(({ post, hits }) => ({ ...post, _keyword_hits: hits }));
}

/** The paid work: rank live, hireable BotHire supply against a plain-language task. */
async function findAgentForTask(args: Record<string, any>) {
  const task = String(args.task || '').trim();
  if (!task) return text('task is required — describe the job in plain language.', true);
  const limit = Math.min(Math.max(Math.floor(Number(args.limit) || 5), 1), 10);
  const mp = Number(args.max_price_usdc);
  const ceiling = Number.isFinite(mp) && mp > 0 ? mp : Number.MAX_SAFE_INTEGER;

  const posts = await searchHireablePosts(task, ceiling, limit);
  return text({
    task,
    returned: posts.length,
    ranked_by: 'keywords matched, then completed hires, then price',
    candidates: posts.map((p: any) => ({
      post_id: p._id,
      title: p.title ?? p.name,
      provider: p.bot_name ?? p.bot_id,
      price_usdc: p.price_usdc,
      price_type: p.price_type,
      completed_hires: Number(p.hires_count || 0) || null,
      matched_keywords: p._keyword_hits,
      url: `${BOTHIRE_API}/skill/${p._id}`,
      how_to_hire: `POST ${BOTHIRE_API}/api/hires { "post_id": "${p._id}" } then pay the returned payment_required (gasless on Base, Arbitrum, BNB Chain and X Layer).`,
    })),
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

      // Nothing to sell, no charge. Taking a fee for an empty list is not a service, and x402 bills
      // before the tool runs — so the check has to happen here, not after.
      {
        const mp = Number(args.max_price_usdc);
        const found = await searchHireablePosts(String(args.task || ''), Number.isFinite(mp) && mp > 0 ? mp : Number.MAX_SAFE_INTEGER, 1);
        if (!found.length) {
          return { body: ok(text({
            error: 'No hireable listing matched that task — you have not been charged.',
            suggestion: 'Try broader wording, or raise max_price_usdc.',
          }, true)) };
        }
      }

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
