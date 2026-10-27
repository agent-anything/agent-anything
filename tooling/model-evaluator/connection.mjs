const MAX_RESPONSE = 2 * 1024 * 1024;

export function configuration(input) {
  if (!input || typeof input !== 'object' || !['ollama', 'openai-compatible'].includes(input.kind)) throw Error('Select a connection type.');
  const url = new URL(input.baseUrl);
  if (url.username || url.password || url.search || url.hash || !['http:', 'https:'].includes(url.protocol) ||
      (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw Error('Use HTTPS, or HTTP on localhost, without URL credentials or query parameters.');
  const config = { kind: input.kind, baseUrl: url.href.replace(/\/$/, ''), model: String(input.model ?? '').trim(),
    apiKey: String(input.apiKey || process.env.MODEL_EVALUATOR_API_KEY || ''),
    timeoutMs: Number(input.timeoutMs ?? 300000), repetitions: Number(input.repetitions ?? 3),
    parameters: input.parameters ?? {} };
  if (!Number.isInteger(config.timeoutMs) || config.timeoutMs < 1000 || config.timeoutMs > 1800000 ||
      !Number.isInteger(config.repetitions) || config.repetitions < 1 || config.repetitions > 10 || config.model.length > 512 ||
      config.apiKey.length > 16384 || !config.parameters || Array.isArray(config.parameters) || typeof config.parameters !== 'object') throw Error('Invalid connection settings or limits.');
  const allowed = config.kind === 'ollama' ? ['temperature', 'num_ctx', 'think'] : ['temperature', 'reasoning_effort', 'thinking'];
  if (Object.keys(config.parameters).some(k => !allowed.includes(k)) || JSON.stringify(config.parameters).length > 4096) throw Error('Unsupported generation parameter.');
  return config;
}

export function safeConfiguration(config) {
  const { apiKey, ...safe } = config;
  return safe;
}

async function request(config, route, body, signal) {
  const response = await fetch(`${config.baseUrl}${route}`, { method: body ? 'POST' : 'GET', redirect: 'error',
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}) },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.any([signal, AbortSignal.timeout(config.timeoutMs)]) });
  const reader = response.body.getReader();
  const chunks = []; let size = 0;
  try {
    while (true) { const { done, value } = await reader.read(); if (done) break;
      size += value.length; if (size > MAX_RESPONSE) throw Error('Response exceeds the evidence size limit.'); chunks.push(value); }
  } finally { await reader.cancel().catch(() => {}); }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!response.ok) throw Error(`HTTP ${response.status}: ${raw.slice(0, 1500)}`);
  try { return JSON.parse(raw); } catch { throw Error('Response is not valid JSON.'); }
}

export async function discover(config, signal = new AbortController().signal) {
  const result = await request(config, config.kind === 'ollama' ? '/api/tags' : '/models', null, signal);
  const rows = config.kind === 'ollama' ? result.models : result.data;
  if (!Array.isArray(rows)) throw Error('The endpoint did not return a model list.');
  return rows.map(row => config.kind === 'ollama' ? row.name : row.id).filter(v => typeof v === 'string').slice(0, 10000);
}

export function encode(config, messages, tools) {
  const p = config.parameters;
  return { model: config.model, messages, stream: false, ...(tools.length ? { tools } : {}),
    ...(config.kind === 'ollama' ? { options: { ...('temperature' in p ? {temperature:p.temperature} : {}), ...('num_ctx' in p ? {num_ctx:p.num_ctx} : {}) },
      ...('think' in p ? {think:p.think} : {}) } : p) };
}

export async function exchange(config, messages, tools, signal, evidence) {
  const body = encode(config, messages, tools);
  const entry = { requestedAt: new Date().toISOString(), request: body, response: null, elapsedMs: null };
  evidence.push(entry);
  const start = performance.now();
  try {
    const raw = await request(config, config.kind === 'ollama' ? '/api/chat' : '/chat/completions', body, signal);
    entry.response = raw;
    const message = config.kind === 'ollama' ? raw.message : raw.choices?.[0]?.message;
    if (!message || message.role !== 'assistant') throw Error('Missing assistant response.');
    const finish = config.kind === 'ollama' ? raw.done_reason : raw.choices?.[0]?.finish_reason;
    const calls = (message.tool_calls ?? []).map((call, i) => ({ id: call.id ?? `call-${i}`, name: call.function?.name,
      arguments: typeof call.function?.arguments === 'string' ? JSON.parse(call.function.arguments) : call.function?.arguments }));
    return { message, calls, text: message.content ?? '', truncated: ['length', 'max_tokens'].includes(finish) };
  } finally { entry.elapsedMs = Math.round(performance.now() - start); }
}

export function toolReply(config, call, result) {
  return { role: 'tool', content: JSON.stringify(result),
    ...(config.kind === 'ollama' ? { tool_name: call.name } : { tool_call_id: call.id }) };
}
