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
      const detail = value?.error?.message || value?.message || text.slice(0, 500) || response.statusText
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

function chatBody(model, prompt, options = {}) {
  const messages = []
  if (options.system) messages.push({ role: 'system', content: options.system })
  messages.push({ role: 'user', content: prompt })
  return {
    model,
    messages,
    temperature: options.temperature ?? 0,
    max_tokens: options.maxTokens ?? 256,
    ...(options.tools ? { tools: options.tools, tool_choice: options.toolChoice ?? 'auto' } : {}),
  }
}

export async function callModel(config, { protocol, model, prompt, system, maxTokens = 256, temperature = 0, tools, toolChoice, signal }) {
  const started = performance.now()
  let url
  let body
  if (protocol === 'openai-responses') {
    url = joinApi(config.baseUrl, '/responses')
    const input = system ? `SYSTEM:\n${system}\n\nUSER:\n${prompt}` : prompt
    body = { model, input, max_output_tokens: maxTokens, temperature }
  } else {
    url = joinApi(config.baseUrl, '/chat/completions')
    body = chatBody(model, prompt, { system, maxTokens, temperature, tools, toolChoice })
  }
  const { value } = await requestJson(url, { method: 'POST', apiKey: config.apiKey, body, timeoutMs: config.timeoutMs, signal })
  const latencyMs = Math.round(performance.now() - started)
  return {
    url,
    payload: value,
    text: extractAssistantText(value, protocol),
    finishReason: finishReasonOf(value, protocol),
    usage: usageOf(value),
    toolCall: protocol === 'openai-completions' ? toolCallOf(value) : null,
    latencyMs,
  }
}

export async function probeProtocol(config, model, signal) {
  const attempts = []
  const requested = config.protocol === 'auto' ? ['openai-completions', 'openai-responses'] : [config.protocol]
  for (const protocol of requested) {
    try {
      const result = await callModel(config, { protocol, model, prompt: '只回复 MODEL_EVAL_PROTOCOL_OK', maxTokens: 32, signal })
      const ok = result.text.includes('MODEL_EVAL_PROTOCOL_OK') || Boolean(result.text)
      attempts.push({ protocol, ok, latencyMs: result.latencyMs, text: result.text.slice(0, 200) })
      if (ok) return { ok: true, protocol, attempts, sample: result }
    } catch (error) {
      attempts.push({ protocol, ok: false, error: serializeError(error) })
    }
  }
  return { ok: false, protocol: null, attempts }
}

export function serializeError(error) {
  return {
    name: error?.name || 'Error',
    message: error?.message || String(error),
    ...(error?.code ? { code: error.code } : {}),
    ...(Number.isInteger(error?.status) ? { status: error.status } : {}),
  }
}
