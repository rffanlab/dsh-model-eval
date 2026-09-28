import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { callModel, probeProtocol } from '../src/http.js'

test('protocol probe falls back to MiniMax chatcompletion_v2 and reuses the successful path', async t => {
  const requests = []
  const server = http.createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      res.statusCode = 404
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ error: { message: 'route not found' } }))
      return
    }
    if (req.method === 'POST' && req.url === '/v1/text/chatcompletion_v2') {
      const body = JSON.parse(raw || '{}')
      requests.push({ url: req.url, body })
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({
        id: 'mm-test',
        model: body.model,
        choices: [{ index: 0, message: { role: 'assistant', content: 'MODEL_EVAL_PROTOCOL_OK' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }
      }))
      return
    }
    res.statusCode = 404
    res.end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const port = server.address().port
  const config = {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey: '',
    protocol: 'auto',
    timeoutMs: 5000,
  }
  const probe = await probeProtocol(config, 'MiniMax-M3.1-Flash-Preview')
  assert.equal(probe.ok, true)
  assert.equal(probe.protocol, 'openai-completions')
  assert.equal(probe.compat.apiPath, '/text/chatcompletion_v2')

  config.requestCompat = probe.compat
  const result = await callModel(config, {
    protocol: probe.protocol,
    model: 'MiniMax-M3.1-Flash-Preview',
    prompt: 'hello',
    maxTokens: 32,
  })
  assert.match(result.url, /\/v1\/text\/chatcompletion_v2$/)
  assert.equal(requests.at(-1).body.model, 'MiniMax-M3.1-Flash-Preview')
})
