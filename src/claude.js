// Thin Claude Messages API client (no SDK, no dependencies).
// Uses forced tool use so every response is schema-shaped JSON, and prompt caching on the system prompt.

const DEFAULT_API_URL = 'https://api.anthropic.com/v1/messages';
const RETRYABLE = new Set([429, 500, 502, 503, 529]);

export const getModel = () => process.env.CLAUDE_MODEL || 'claude-sonnet-4-5';
export const getMode = () => (process.env.ANTHROPIC_API_KEY ? 'live' : 'mock');

// When GATEWAY_URL is set, every call (generation and key verification alike) goes through that
// internal proxy instead of api.anthropic.com directly — e.g. an org-internal LLM gateway that
// fronts Anthropic for billing/access control. Assumed to mirror Anthropic's own Messages API
// shape at POST {GATEWAY_URL}/v1/messages; adjust here if your gateway's contract differs.
export const getApiUrl = () => {
  const gateway = process.env.GATEWAY_URL;
  return gateway ? `${gateway.replace(/\/+$/, '')}/v1/messages` : DEFAULT_API_URL;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Confirms a key actually works before the app starts relying on it (used by both the UI's
// "Connect Claude" form and the Azure Key Vault auto-load at startup). Makes one real, minimal
// Messages API call — not a models-list call — since that's the one endpoint we know every
// target (Anthropic directly, or a compatible gateway) must support.
//
// Retries transient connection failures (e.g. undici ConnectTimeoutError) the same way callTool
// does below: observed intermittently through a corporate TLS-inspecting proxy, and this call
// only ever runs once (at startup, or on a manual "Connect" click) so it has no other chance to
// recover — unlike real generation calls, which are retried per-attempt inside the pipeline.
export async function verifyApiKey(key) {
  const url = getApiUrl();
  const timeoutMs = process.env.GATEWAY_URL ? 90_000 : 15_000;
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    let check;
    try {
      check = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: getModel(), max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }),
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (err) {
      lastError = `Could not reach ${url} to verify the key (${err.cause?.code || err.name || 'network'} error)`;
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    if (check.status === 401 || check.status === 403) return { ok: false, error: 'The key was rejected (401/403)' };
    if (!check.ok) {
      const text = await check.text().catch(() => '');
      return { ok: false, error: `Key check failed (HTTP ${check.status})${text ? ': ' + text.slice(0, 200) : ''}` };
    }
    return { ok: true };
  }
  return { ok: false, error: lastError };
}

export async function callTool({ system, user, tool, maxTokens = 2500, temperature = 0.3 }) {
  const body = {
    model: getModel(),
    max_tokens: maxTokens,
    // Some gateway-served models reject `temperature` outright ("deprecated for this model")
    // rather than just ignoring it, so omit it entirely in gateway mode.
    ...(process.env.GATEWAY_URL ? {} : { temperature }),
    // The system prompt (brand voice + market rules) is identical for every product in a market,
    // so it is cached: later calls pay ~10% of the input price for it.
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    tools: [tool],
    // Anthropic natively supports forcing a specific tool (reliable structured output every
    // time). Some gateways/backends only support "auto" (e.g. Claude served via an Azure AI
    // passthrough through LiteLLM rejects tool_choice "tool"/"any") — fall back to that when a
    // gateway is configured; the system prompt already instructs the model to always call it,
    // and with only one tool offered compliance is normally still near-total.
    tool_choice: process.env.GATEWAY_URL ? { type: 'auto' } : { type: 'tool', name: tool.name },
    messages: [{ role: 'user', content: user }]
  };

  let lastError;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(getApiUrl(), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000)
      });
      if (!res.ok) {
        const text = await res.text();
        lastError = new Error(`Claude API ${res.status}: ${text.slice(0, 300)}`);
        if (RETRYABLE.has(res.status)) {
          const retryAfter = Number(res.headers.get('retry-after')) || 0;
          await sleep(Math.max(retryAfter * 1000, 800 * 2 ** attempt));
          continue;
        }
        throw lastError;
      }
      const data = await res.json();
      const block = data.content?.find((b) => b.type === 'tool_use');
      if (!block) {
        lastError = new Error('Claude returned no structured output (no tool_use block)');
        // With tool_choice "auto" (gateway mode; see above) the model occasionally replies in
        // plain text instead of calling the tool. Retrying with an explicit nudge usually works,
        // rather than failing the whole generation over one non-compliant reply.
        if (attempt < 3) {
          body.messages = [
            { role: 'user', content: user },
            { role: 'assistant', content: data.content },
            { role: 'user', content: `You must respond by calling the ${tool.name} tool. Do not reply with plain text.` }
          ];
          await sleep(500 * 2 ** attempt);
          continue;
        }
        throw lastError;
      }
      const u = data.usage || {};
      return {
        output: block.input,
        usage: {
          input: u.input_tokens || 0,
          output: u.output_tokens || 0,
          cacheWrite: u.cache_creation_input_tokens || 0,
          cacheRead: u.cache_read_input_tokens || 0
        }
      };
    } catch (err) {
      lastError = err;
      if (err.name === 'TimeoutError' || err.name === 'TypeError') {
        await sleep(800 * 2 ** attempt);
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}
