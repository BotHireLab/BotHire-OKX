/**
 * A standalone MCP server you can actually run: `npm i && npm run dev`, then point any MCP client at
 * http://localhost:8402/mcp. No BotHire account, no key, no signup needed to see the payment challenge.
 *
 * Transport is stateless Streamable HTTP — self-contained POSTs, 202 for notifications, 405 on GET.
 * That is the shape the current MCP revisions prescribe (2026-07-28 removes the GET stream and
 * protocol-level sessions entirely), so there is nothing to resume and nothing to keep in memory.
 */
import { createServer } from 'node:http';
import { handleRpc, PROTOCOL_VERSION, SUPPORTED_PROTOCOLS, PRICE_USD, PAYEE, SERVER_INFO } from './mcp.js';
import { enabledChains } from './chains.js';

const PORT = Number(process.env.PORT || 8402);
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, '');

const CORS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, GET, OPTIONS',
  'access-control-allow-headers': 'content-type, x-payment, mcp-protocol-version, mcp-session-id',
  'access-control-expose-headers': 'mcp-protocol-version, x-payment-response',
};

const send = (res: any, status: number, body: unknown, extra: Record<string, string> = {}) => {
  const payload = body === null ? '' : JSON.stringify(body);
  res.writeHead(status, { ...CORS, 'mcp-protocol-version': PROTOCOL_VERSION, ...(payload ? { 'content-type': 'application/json' } : {}), ...extra });
  res.end(payload);
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', PUBLIC_URL);

  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }

  if (req.method === 'GET') {
    // GET would open a server-initiated event stream; this server is stateless and has nothing to push.
    // 405 is the spec's explicit alternative and every reference client tolerates it.
    return send(res, url.pathname === '/' ? 200 : 405, {
      name: SERVER_INFO.name,
      transport: 'streamable-http',
      endpoint: `${PUBLIC_URL}/mcp`,
      pricing: { per_call_usd: PRICE_USD, configured: Boolean(PAYEE) },
      chains: enabledChains().map((c) => ({ chain: c.label, caip: c.caip, tokens: c.tokens.map((t) => t.symbol) })),
      usage: 'POST JSON-RPC 2.0 here. Start with initialize, then tools/list. Paid tools answer 402 with x402 requirements until paid.',
      live_reference_deployment: 'https://www.bothire.io/mcp/paid',
    }, url.pathname === '/' ? {} : { allow: 'POST, OPTIONS' });
  }

  if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' }, { allow: 'POST, OPTIONS' });

  const version = req.headers['mcp-protocol-version'];
  if (typeof version === 'string' && !SUPPORTED_PROTOCOLS.has(version.trim())) {
    return send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: `Unsupported MCP-Protocol-Version: ${version}` } });
  }

  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1_000_000) return send(res, 413, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Request too large' } });
  }

  let msg: any;
  try { msg = JSON.parse(raw); }
  catch { return send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }

  // A payment challenge is per call and a batch carries no per-message HTTP status, so batches are out.
  if (Array.isArray(msg)) {
    return send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Batching is not supported: a payment challenge is per call.' } });
  }

  try {
    const xPayment = (req.headers['x-payment'] as string | undefined) ?? null;
    const { body, status, headers } = await handleRpc(msg, xPayment, `${PUBLIC_URL}/mcp`);
    if (body === null) return send(res, 202, null);
    return send(res, status || 200, body, headers || {});
  } catch (e: any) {
    return send(res, 500, { jsonrpc: '2.0', id: msg?.id ?? null, error: { code: -32603, message: e?.message || 'internal error' } });
  }
});

server.listen(PORT, () => {
  console.log(`BotHire × OKX AI — paid MCP service`);
  console.log(`  endpoint : ${PUBLIC_URL}/mcp`);
  console.log(`  price    : $${PRICE_USD} per paid call`);
  console.log(`  payee    : ${PAYEE || '(unset — the service will refuse to sell rather than invent an address)'}`);
  console.log(`  chains   : ${enabledChains().map((c) => `${c.label} [${c.tokens.map((t) => t.symbol).join('/')}]`).join(', ')}`);
});
