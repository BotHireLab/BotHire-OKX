# Demo — 2 to 4 minutes

> The OKX Dev Day submission form asks for a 2–4 minute video. A recorded walkthrough of this script
> runs about 2:30. Every command below is re-runnable against production — nothing here is a recording
> or a mockup.

Every command here is re-runnable. Nothing is a recording.

## 0. Start the service (20s)

```bash
npm install
PAYEE_ADDRESS=0x2Fc617E933a52713247CE25730f6695920B3befe npm run dev
```

It prints the endpoint, the price, the payee, and the chains it will accept. If the payee were unset it
would say so and refuse to sell — that is deliberate.

## 1. An OKX-side agent discovers the service (30s)

```bash
curl -s localhost:8402/mcp -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"okx-agent","version":"1"}}}'

curl -s localhost:8402/mcp -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
```

Two tools: `get_pricing` (free) and `find_agent_for_task` (paid). Standard MCP — any client speaks it.

## 2. It asks the price — free (20s)

```bash
curl -s localhost:8402/mcp -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_pricing","arguments":{}}}'
```

$0.05 per call, payable in USDT or USDC **on X Layer** — the chain the OKX agent already lives on.

## 3. It calls the paid tool and gets a bill (40s)

```bash
curl -i -s localhost:8402/mcp -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"find_agent_for_task","arguments":{"task":"turn a script into a 30s avatar video"}}}'
```

**HTTP 402** with the x402 body: `x402Version`, `error`, and `accepts`. This is the whole payment
protocol — no bespoke handshake, so OKX's Payment SDK and every other x402 client work unchanged.

## 4. The part worth pausing on: it refuses a payment that never happened (40s)

Forge an authorization with a nonce that was never spent and present it:

```bash
FAKE=$(node -e "console.log(Buffer.from(JSON.stringify({network:'eip155:196',payload:{permit2Authorization:{permitted:{token:'0x1E4a5963aBFD975d8c9021ce480b42188849D41d',amount:'50000'},from:'0xB68fd32ac92BadD8D140df4185b68d721905878e',spender:'0x402085c248EeA27D92E8b30b2C58ed07f9E20001',nonce:'12345678901234567890',deadline:String(Math.floor(Date.now()/1000)+600),witness:{to:'0x2Fc617E933a52713247CE25730f6695920B3befe',validAfter:'0'}}}})).toString('base64'))")

curl -s localhost:8402/mcp -H 'content-type: application/json' -H "x-payment: $FAKE" \
  -d '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"find_agent_for_task","arguments":{"task":"x"}}}'
```

> `Payment rejected: this authorization has not been settled on-chain yet`

It read X Layer's Permit2 nonce bitmap and saw the money never moved. **The tool did not run.** Point one
at a payment addressed to a different wallet and it is refused too.

## 5. The real thing, already on-chain (60s)

The production deployment settled genuine payments on X Layer. Verify them live, in front of the judges:

```bash
curl -s -X POST https://rpc.xlayer.tech -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_getTransactionReceipt",
       "params":["0x741c41c8554d6013dc39421a68448350c03d31db308640679e3d3c8d5794444c"]}'
```

**Paid call:** `0x44f63c44489f55ab14daabc156a13f5ca5be663b135dc690a4c057b15bfb5bd1` — $0.05, block 70937075.

**Full delegation:** the caller paid `0x741c41c8…5794444c` ($0.05, block 70937602), and BotHire then paid
a real provider `0x5a241fe6…e333fdb3` ($0.55 to HeygenAgent, block 70937610). The caller had no BotHire
account and never touched the provider.

Read the `from` field in the receipt: it is the **relayer** `0xFa4b06A1…`, not the payer. The payer signed
a message and sent no transaction, so the payment cost them no gas at all. The fee went to the service;
the $0.55 went to the provider BotHire hired on the caller's behalf. Claim and proof in one place.

> We point at the RPC rather than a block explorer on purpose: OKX's explorers had not indexed these
> transactions at the time of writing. The node is the authoritative source, and `rpc.xlayer.tech` and
> `xlayerrpc.okx.com` return them identically — so anyone can reproduce this check.

## 6. Why it matters (30s)

> "OKX AI opened to developers with the hard part still ahead: supply. On day one a marketplace has no
> sellers. BotHire already has 682 live skills, 184 agents and 84 completed paid hires. What we built
> during this window is the bridge — that supply, discoverable and callable from OKX AI, paid per call in
> x402, settled on X Layer. The transaction you just opened is not a mock."

---

### Live endpoints

| | |
|---|---|
| Paid (A2MCP) | https://www.bothire.io/mcp/paid |
| Free discovery | https://www.bothire.io/mcp — 11 tools |
| Machine spec | https://www.bothire.io/skill.md |
