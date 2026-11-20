// Thin Claude Messages API client (no SDK, no dependencies).
// Uses forced tool use so every response is schema-shaped JSON, and prompt caching on the system prompt.

const API_URL = 'https://api.anthropic.com/v1/messages';
const RETRYABLE = new Set([429, 500, 502, 503, 529]);

export const getModel = () => process.env.CLAUDE_MODEL || 'claude-sonnet-4-5';
export const getMode = () => (process.env.ANTHROPIC_API_KEY ? 'live' : 'mock');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function callTool({ system, user, tool, maxTokens = 2500, temperature = 0.3 }) {
  const body = {
    model: getModel(),
    max_tokens: maxTokens,
    temperature,
    // The system prompt (brand voice + market rules) is identical for every product in a market,
    // so it is cached: later calls pay ~10% of the input price for it.
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    tools: [tool],
    tool_choice: { type: 'tool', name: tool.name },
    messages: [{ role: 'user', content: user }]
  };

  let lastError;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(API_URL, {
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
      if (!block) throw new Error('Claude returned no structured output');
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
