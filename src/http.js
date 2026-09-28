import { extractAssistantText, finishReasonOf, isPlaceholderKey, joinApi, toolCallOf, usageOf } from './core.js'

export class HttpError extends Error {
  constructor(message, { status, body, url } = {}) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.body = body
    this.url = url
  }
}

function headersOf(apiKey, extra = {}) {
  const headers = { accept: 'application/json', ...extra }
  if (!isPlaceholderKey(apiKey)) headers.authorization = `Bearer ${apiKey}`
  return headers
}

export async function requestJson(url, { method = 'GET', apiKey, body, timeoutMs = 120000, signal } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(`request timeout after ${timeoutMs}ms`)), timeoutMs)
  const onAbort = () => controller.abort(signal.reason || new Error('aborted'))
  if (signal) signal.addEventListener('abort', onAbort, { once: true })
  try {
    const response = await fetch(url, {
      method,
      headers: headersOf(apiKey, body === undefined ? {} : { 'content-type': 'application/json' }),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    })
    const text = await response.text()
    let value
    try { value = text ? JSON.parse(text) : {} } catch { value = { raw: text } }
    if (!response.ok) {
      const detail = value?.error?.message || value?.message || text.slice(0, 1000) || response.statusText
      throw new HttpError(`HTTP ${response.status}: ${detail}`, { status: response.status, body: value, url })
    }
    return { value, status: response.status, headers: response.headers }
  } finally {
    clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', onAbort)
  }
}

export async function discoverModels(config, signal) {
  const url = joinApi(config.baseUrl, '/models')
  try {
    const { value } = await requestJson(url, { apiKey: config.apiKey, timeoutMs: Math.min(config.timeoutMs, 30000), signal })
    const rows = Array.isArray(value?.data) ? value.data : Array.isArray(value?.models) ? value.models : []
    const models = rows.map(row => typeof row === 'string' ? row : row?.id || row?.name).filter(Boolean)
    return { ok: true, url, models, rawShape: Array.isArray(value?.data) ? 'data[]' : Array.isArray(value?.models) ? 'models[]' : 'unknown' }
  } catch (error) {
    return { ok: false, url, models: [], error: serializeError(error) }
  }
}

function chatBody(model, prompt, options = {}, compat = {}) {
  const messages = []
  if (options.system) messages.push({ role: 'system', content: options.system })
  messages.push({ role: 'user', content: prompt })
  const body = { model, messages }
  if (compat.supportsTemperature === true && options.temperature != null) body.temperature = options.temperature
  if (options.maxTokens != null && compat.omitMaxTokens !== true) {
    body[compat.maxTokensField || 'max_tokens'] = options.maxTokens
  }
  if (options.tools) {
    body.tools = options.tools
    if (options.toolChoice !== undefined && compat.omitToolChoice !== true) body.tool_choice = options.toolChoice
  }
  return body
}

function responsesBody(model, prompt, options = {}, compat = {}) {
  const input = options.system ? `SYSTEM:\n${options.system}\n\nUSER:\n${prompt}` : prompt
  const body = { model, input }
  if (compat.supportsTemperature === true && options.temperature != null) body.temperature = options.temperature
  if (options.maxTokens != null && compat.omitMaxOutputTokens !== true) body.max_output_tokens = options.maxTokens
  return body
}

export async function callModel(config, { protocol, model, prompt, system, maxTokens = 256, temperature = 0, tools, toolChoice, signal }) {
  const started = performance.now()
  const compat = config.requestCompat || {}
  let url
  let body
  if (protocol === 'openai-responses') {
    url = joinApi(config.baseUrl, '/responses')
    body = responsesBody(model, prompt, { system, maxTokens, temperature }, compat)
  } else {
    url = joinApi(config.baseUrl, '/chat/completions')
    body = chatBody(model, prompt, { system, maxTokens, temperature, tools, toolChoice }, compat)
  }
  const { value } = await requestJson(url, { method: 'POST', apiKey: config.apiKey, body, timeoutMs: config.timeoutMs, signal })
  const latencyMs = Math.round(performance.now() - started)
  return {
    url,
    requestShape: {
      maxTokensField: protocol === 'openai-responses' ? (body.max_output_tokens == null ? null : 'max_output_tokens') : (body.max_completion_tokens == null ? (body.max_tokens == null ? null : 'max_tokens') : 'max_completion_tokens'),
      temperature: Object.prototype.hasOwnProperty.call(body, 'temperature'),
      toolChoice: Object.prototype.hasOwnProperty.call(body, 'tool_choice'),
    },
    payload: value,
    responseModel: typeof value?.model === 'string' ? value.model : null,
    text: extractAssistantText(value, protocol),
    finishReason: finishReasonOf(value, protocol),
    usage: usageOf(value),
    toolCall: protocol === 'openai-completions' ? toolCallOf(value) : null,
    latencyMs,
  }
}

function shapeOk(value, protocol) {
  if (protocol === 'openai-responses') {
    return Boolean(value && typeof value === 'object' && (
      typeof value.id === 'string' ||
      typeof value.output_text === 'string' ||
      Array.isArray(value.output) ||
      typeof value.status === 'string'
    ))
  }
  return Array.isArray(value?.choices)
}

async function probeRequest(config, protocol, model, variant, body, signal) {
  const url = joinApi(config.baseUrl, protocol === 'openai-responses' ? '/responses' : '/chat/completions')
  const started = performance.now()
  try {
    const { value } = await requestJson(url, { method: 'POST', apiKey: config.apiKey, body, timeoutMs: config.timeoutMs, signal })
    const ok = shapeOk(value, protocol)
    return {
      protocol,
      variant,
      ok,
      httpOk: true,
      url,
      latencyMs: Math.round(performance.now() - started),
      responseModel: typeof value?.model === 'string' ? value.model : null,
      responseShape: protocol === 'openai-responses'
        ? { id: typeof value?.id === 'string', output: Array.isArray(value?.output), outputText: typeof value?.output_text === 'string', status: value?.status ?? null }
        : { choices: Array.isArray(value?.choices), finishReason: value?.choices?.[0]?.finish_reason ?? null },
      text: extractAssistantText(value, protocol).slice(0, 300),
      ...(ok ? {} : { error: { message: 'HTTP 2xx but response shape is not recognized as this protocol' } }),
    }
  } catch (error) {
    return {
      protocol,
      variant,
      ok: false,
      httpOk: false,
      url,
      latencyMs: Math.round(performance.now() - started),
      error: serializeError(error),
    }
  }
}

async function probeChatCompletions(config, model, signal) {
  const prompt = '只回复 MODEL_EVAL_PROTOCOL_OK'
  const base = { model, messages: [{ role: 'user', content: prompt }] }
  const attempts = []

  // First prove the protocol with the smallest legal request. Do not make
  // temperature or token-limit support a prerequisite for protocol support.
  const minimal = await probeRequest(config, 'openai-completions', model, 'minimal', base, signal)
  attempts.push(minimal)
  if (!minimal.ok) {
    for (const [variant, field] of [['max_completion_tokens', 'max_completion_tokens'], ['max_tokens', 'max_tokens']]) {
      const attempt = await probeRequest(config, 'openai-completions', model, variant, { ...base, [field]: 32 }, signal)
      attempts.push(attempt)
      if (attempt.ok) return { ok: true, protocol: 'openai-completions', attempts, compat: { maxTokensField: field, supportsTemperature: false } }
    }
    return { ok: false, protocol: 'openai-completions', attempts }
  }

  let maxTokensField = null
  for (const field of ['max_completion_tokens', 'max_tokens']) {
    const attempt = await probeRequest(config, 'openai-completions', model, `cap:${field}`, { ...base, [field]: 32 }, signal)
    attempts.push(attempt)
    if (attempt.ok) { maxTokensField = field; break }
  }

  const capBody = maxTokensField ? { ...base, [maxTokensField]: 32 } : base
  const temperature = await probeRequest(config, 'openai-completions', model, 'temperature:0', { ...capBody, temperature: 0 }, signal)
  attempts.push(temperature)

  return {
    ok: true,
    protocol: 'openai-completions',
    attempts,
    compat: {
      ...(maxTokensField ? { maxTokensField } : { omitMaxTokens: true }),
      supportsTemperature: temperature.ok,
    },
  }
}

async function probeResponses(config, model, signal) {
  const base = { model, input: '只回复 MODEL_EVAL_PROTOCOL_OK' }
  const attempts = []
  const minimal = await probeRequest(config, 'openai-responses', model, 'minimal', base, signal)
  attempts.push(minimal)
  if (!minimal.ok) {
    const capped = await probeRequest(config, 'openai-responses', model, 'max_output_tokens', { ...base, max_output_tokens: 32 }, signal)
    attempts.push(capped)
    if (!capped.ok) return { ok: false, protocol: 'openai-responses', attempts }
    return { ok: true, protocol: 'openai-responses', attempts, compat: { supportsTemperature: false } }
  }

  const cap = await probeRequest(config, 'openai-responses', model, 'max_output_tokens', { ...base, max_output_tokens: 32 }, signal)
  attempts.push(cap)
  const capBody = cap.ok ? { ...base, max_output_tokens: 32 } : base
  const temperature = await probeRequest(config, 'openai-responses', model, 'temperature:0', { ...capBody, temperature: 0 }, signal)
  attempts.push(temperature)
  return {
    ok: true,
    protocol: 'openai-responses',
    attempts,
    compat: {
      omitMaxOutputTokens: !cap.ok,
      supportsTemperature: temperature.ok,
    },
  }
}

export async function probeProtocol(config, model, signal) {
  const requested = config.protocol === 'auto' ? ['openai-completions', 'openai-responses'] : [config.protocol]
  const attempts = []
  for (const protocol of requested) {
    const result = protocol === 'openai-responses'
      ? await probeResponses(config, model, signal)
      : await probeChatCompletions(config, model, signal)
    attempts.push(...result.attempts)
    if (result.ok) return { ok: true, protocol: result.protocol, compat: result.compat || {}, attempts }
  }
  return { ok: false, protocol: null, compat: {}, attempts }
}

function safeBody(value) {
  if (value == null) return undefined
  try {
    const text = JSON.stringify(value)
    return text.length > 4000 ? `${text.slice(0, 4000)}...[truncated]` : value
  } catch {
    return String(value).slice(0, 4000)
  }
}

export function serializeError(error) {
  return {
    name: error?.name || 'Error',
    message: error?.message || String(error),
    ...(error?.code ? { code: error.code } : {}),
    ...(Number.isInteger(error?.status) ? { status: error.status } : {}),
    ...(error?.url ? { url: error.url } : {}),
    ...(error?.body !== undefined ? { response: safeBody(error.body) } : {}),
  }
}
