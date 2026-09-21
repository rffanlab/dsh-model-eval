import { extname } from 'node:path'

export const SUITES = Object.freeze(['smoke', 'standard', 'full'])
export const PROTOCOLS = Object.freeze(['auto', 'openai-completions', 'openai-responses'])

export function normalizeBaseUrl(value) {
  const raw = String(value || '').trim().replace(/\/+$/, '')
  if (!raw) throw new Error('API Base URL is required')
  const url = new URL(raw)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('API Base URL must use http:// or https://')
  return url.toString().replace(/\/$/, '')
}

export function normalizeConfig(input = {}) {
  const baseUrl = normalizeBaseUrl(input.baseUrl)
  const suite = SUITES.includes(input.suite) ? input.suite : 'standard'
  const protocol = PROTOCOLS.includes(input.protocol) ? input.protocol : 'auto'
  const declaredContext = input.declaredContext == null || input.declaredContext === ''
    ? undefined
    : Number(input.declaredContext)
  if (declaredContext !== undefined && (!Number.isSafeInteger(declaredContext) || declaredContext < 1024)) {
    throw new Error('Declared context must be an integer >= 1024')
  }
  const timeoutMs = input.timeoutMs == null ? 120_000 : Number(input.timeoutMs)
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1000) throw new Error('timeoutMs must be >= 1000')
  return {
    baseUrl,
    apiKey: typeof input.apiKey === 'string' ? input.apiKey : '',
    model: String(input.model || 'auto').trim() || 'auto',
    suite,
    protocol,
    declaredContext,
    timeoutMs,
    runDshAgent: input.runDshAgent !== false,
    dshProfile: String(input.dshProfile || 'sdk'),
    reasoningEffort: input.reasoningEffort ? String(input.reasoningEffort) : undefined,
  }
}

export function redactConfig(config) {
  const { apiKey, ...rest } = config
  return { ...rest, apiKeyPresent: Boolean(apiKey && !isPlaceholderKey(apiKey)) }
}

export function isPlaceholderKey(value) {
  const key = String(value || '').trim().toUpperCase()
  return !key || key === 'EMPTY' || key === 'NONE' || key === 'NULL' || key === '-'
}

export function joinApi(baseUrl, path) {
  const base = String(baseUrl).replace(/\/+$/, '')
  const normalized = path.startsWith('/') ? path : `/${path}`
  if (/\/v1$/i.test(base) && /^\/v1(?:\/|$)/i.test(normalized)) return base + normalized.slice(3)
  return base + normalized
}

export function extractAssistantText(payload, protocol) {
  if (protocol === 'openai-responses') {
    if (typeof payload?.output_text === 'string') return payload.output_text
    const pieces = []
    for (const item of payload?.output || []) {
      for (const part of item?.content || []) {
        if (typeof part?.text === 'string') pieces.push(part.text)
      }
    }
    return pieces.join('')
  }
  const message = payload?.choices?.[0]?.message
  if (typeof message?.content === 'string') return message.content
  if (Array.isArray(message?.content)) return message.content.map(x => x?.text || '').join('')
  return ''
}

export function finishReasonOf(payload, protocol) {
  if (protocol === 'openai-responses') return payload?.status || payload?.incomplete_details?.reason
  return payload?.choices?.[0]?.finish_reason
}

export function usageOf(payload) {
  const usage = payload?.usage || {}
  return {
    inputTokens: usage.prompt_tokens ?? usage.input_tokens ?? null,
    outputTokens: usage.completion_tokens ?? usage.output_tokens ?? null,
    totalTokens: usage.total_tokens ?? null,
    cachedTokens: usage.prompt_tokens_details?.cached_tokens ?? usage.input_tokens_details?.cached_tokens ?? null,
  }
}

export function normalizeExact(value) {
  return String(value || '').trim().replace(/^['"`]+|['"`]+$/g, '').trim()
}

export function judgeExact(text, expected) {
  const actual = normalizeExact(text)
  return { passed: actual === expected, expected, actual }
}

export function judgeJson(text, expected) {
  try {
    const value = JSON.parse(String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''))
    const passed = Object.keys(expected).every(key => JSON.stringify(value?.[key]) === JSON.stringify(expected[key]))
      && Object.keys(value || {}).length === Object.keys(expected).length
    return { passed, expected, actual: value }
  } catch (error) {
    return { passed: false, expected, actual: null, error: `invalid JSON: ${error.message}` }
  }
}

export function toolCallOf(payload) {
  const calls = payload?.choices?.[0]?.message?.tool_calls
  if (!Array.isArray(calls) || !calls.length) return null
  const call = calls[0]
  let args = call?.function?.arguments
  try { args = typeof args === 'string' ? JSON.parse(args) : args } catch {}
  return { id: call?.id, name: call?.function?.name, arguments: args }
}

export function classifyFailure(error) {
  const status = Number(error?.status || error?.statusCode || error?.response?.status)
  const code = String(error?.code || '')
  const message = String(error?.message || error || '')
  if (status === 401 || status === 403) return 'API_AUTH'
  if (status === 404) return 'API_ENDPOINT_NOT_FOUND'
  if (status === 429) return 'RATE_LIMIT'
  if (status >= 500) return 'SERVICE_5XX'
  if (/timeout|timed out|abort/i.test(message) || code === 'ABORT_ERR') return 'TIMEOUT'
  if (/ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|network|fetch failed/i.test(`${code} ${message}`)) return 'API_CONNECTION'
  if (/context|maximum.*token|too many tokens/i.test(message)) return 'CONTEXT_OVERFLOW'
  return 'MODEL_OR_PROTOCOL_FAILURE'
}

export function suiteCases(suite, declaredContext) {
  const rows = [
    { id: 'instruction-exact', category: 'instruction', title: '严格指令：只输出固定字符串' },
    { id: 'instruction-json', category: 'instruction', title: '严格 JSON 输出' },
    { id: 'tool-call', category: 'tool', title: '函数/工具调用参数构造' },
    { id: 'latency-sample', category: 'performance', title: '基础延迟与吞吐样本' },
  ]
  if (suite !== 'smoke') {
    rows.push({ id: 'context-4k', category: 'context', title: '约 4K Token 上下文召回', estimatedTokens: 4096 })
    rows.push({ id: 'dsh-agent-file', category: 'agent', title: 'DSH Agent 文件交付与隐藏验收' })
  }
  if (suite === 'full') {
    const levels = [8192, 16384, 32768, 65536, 98304, 131072]
    for (const tokens of levels) {
      if (declaredContext && tokens > declaredContext) continue
      rows.push({ id: `context-${Math.round(tokens / 1024)}k`, category: 'context', title: `约 ${Math.round(tokens / 1024)}K Token 上下文召回`, estimatedTokens: tokens })
    }
    rows.push({ id: 'dsh-agent-recovery', category: 'recovery', title: 'DSH Agent 测试失败后的自动恢复' })
    rows.push({ id: 'dsh-agent-media', category: 'artifact', title: 'DSH Agent 视频/文档/媒体交付' })
  }
  return rows
}

export function scoreCases(cases = []) {
  const scored = cases.filter(row => row.status === 'passed' || row.status === 'failed')
  const passed = scored.filter(row => row.status === 'passed').length
  const failed = scored.length - passed
  return {
    passed,
    failed,
    skipped: cases.filter(row => row.status === 'skipped').length,
    total: cases.length,
    scored: scored.length,
    passRate: scored.length ? passed / scored.length : null,
  }
}

export function byCategory(cases = []) {
  const out = {}
  for (const row of cases) {
    const bucket = out[row.category] ||= []
    bucket.push(row)
  }
  return Object.fromEntries(Object.entries(out).map(([category, rows]) => [category, scoreCases(rows)]))
}

export function safeId(value) {
  return String(value || '').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120) || 'item'
}

export function artifactKind(path) {
  const ext = extname(String(path || '')).slice(1).toLowerCase()
  if (['png','jpg','jpeg','gif','webp','avif','bmp','svg'].includes(ext)) return 'image'
  if (['mp4','webm','mov','m4v','mkv','ogv'].includes(ext)) return 'video'
  if (['mp3','wav','ogg','oga','m4a','aac','flac','opus'].includes(ext)) return 'audio'
  if (['pdf','doc','docx','rtf','odt','xls','xlsx','ods','ppt','pptx','odp','md','txt','csv','json','html','htm'].includes(ext)) return 'document'
  return 'file'
}

export function mimeOf(path) {
  const ext = extname(String(path || '')).slice(1).toLowerCase()
  const map = {
    png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',gif:'image/gif',webp:'image/webp',avif:'image/avif',svg:'image/svg+xml',bmp:'image/bmp',
    mp4:'video/mp4',webm:'video/webm',mov:'video/quicktime',m4v:'video/x-m4v',mkv:'video/x-matroska',ogv:'video/ogg',
    mp3:'audio/mpeg',wav:'audio/wav',ogg:'audio/ogg',oga:'audio/ogg',m4a:'audio/mp4',aac:'audio/aac',flac:'audio/flac',opus:'audio/opus',
    pdf:'application/pdf',docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',pptx:'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    md:'text/markdown; charset=utf-8',txt:'text/plain; charset=utf-8',csv:'text/csv; charset=utf-8',json:'application/json; charset=utf-8',html:'text/html; charset=utf-8',htm:'text/html; charset=utf-8'
  }
  return map[ext] || 'application/octet-stream'
}
