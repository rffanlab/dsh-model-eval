import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { collectArtifacts } from './artifacts.js'
import { byCategory, classifyFailure, judgeExact, judgeJson, normalizeConfig, redactConfig, scoreCases, suiteCases } from './core.js'
import { callModel, discoverModels, probeProtocol, serializeError } from './http.js'
import { writeReports } from './report.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PYTHON_RUNNER = join(__dirname, '..', 'python', 'dsh_runner.py')

function nowIso() { return new Date().toISOString() }
function runId() { return `${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}-${randomUUID().slice(0, 8)}` }
function median(values) { const sorted = [...values].sort((a,b)=>a-b); return sorted.length ? sorted[Math.floor(sorted.length/2)] : null }

async function exists(path) { try { await readFile(path); return true } catch { return false } }

function trimDetail(value, max = 4000) {
  const text = String(value ?? '')
  return text.length <= max ? text : text.slice(0, max) + '\n...[truncated]'
}

function makeContextPrompt(estimatedTokens, sentinel) {
  const targetChars = Math.max(6000, estimatedTokens * 4)
  const base = 'amber cedar delta harbor ivory juniper lantern meadow orbit quartz river summit velvet willow xenon yellow zephyr '
  let filler = ''
  let i = 0
  while (filler.length < targetChars) {
    filler += `R${String(i++).padStart(6,'0')} ${base}${(i * 7919) % 1000003}.\n`
  }
  const cut = Math.floor(filler.length * 0.72)
  return `这是长上下文召回测试。下面包含大量无关记录，其中只有一行 KEY 是目标。不要总结。\n\n${filler.slice(0, cut)}\nKEY=${sentinel}\n${filler.slice(cut)}\n\n问题：KEY 的值是什么？只返回 KEY 的值，不要解释。`
}

function findCase(run, id) {
  const row = run.cases.find(item => item.id === id)
  if (!row) throw new Error(`unknown case ${id}`)
  return row
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(value, null, 2))
}

async function runPython(payload, { timeoutMs = 15 * 60_000, signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.DSH_MODEL_EVAL_PYTHON || 'python3', [PYTHON_RUNNER], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
    })
    let stdout = '', stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 2000).unref()
    }, timeoutMs)
    const onAbort = () => child.kill('SIGTERM')
    if (signal) signal.addEventListener('abort', onAbort, { once: true })
    child.stdout.on('data', chunk => { stdout += chunk.toString() })
    child.stderr.on('data', chunk => { stderr += chunk.toString() })
    child.on('error', error => { clearTimeout(timer); reject(error) })
    child.on('close', code => {
      clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onAbort)
      const marker = stdout.trim().split(/\r?\n/).reverse().find(line => line.startsWith('DSH_MODEL_EVAL_RESULT='))
      let result
      try { result = marker ? JSON.parse(marker.slice('DSH_MODEL_EVAL_RESULT='.length)) : null } catch {}
      resolve({ code, stdout, stderr, result })
    })
    child.stdin.end(JSON.stringify(payload))
  })
}

export class EvalEngine {
  constructor({ rootDir }) {
    this.rootDir = rootDir
    this.active = new Map()
  }

  async start(input, onUpdate) {
    const config = normalizeConfig(input)
    const id = runId()
    const runDir = join(this.rootDir, id)
    await mkdir(runDir, { recursive: true })
    const controller = new AbortController()
    const run = {
      schemaVersion: 1,
      id,
      status: 'running',
      startedAt: nowIso(),
      completedAt: null,
      config: redactConfig(config),
      model: null,
      protocol: null,
      discovery: null,
      protocolProbe: null,
      cases: suiteCases(config.suite, config.declaredContext).map(row => ({ ...row, status: 'pending', artifacts: [] })),
      performance: null,
      summary: null,
      categories: null,
      error: null,
    }
    this.active.set(id, { controller, promise: null, config, run, runDir })
    await this.persist(run, runDir, onUpdate)
    const promise = this.execute(run, runDir, config, controller.signal, onUpdate)
      .catch(async error => {
        run.status = controller.signal.aborted ? 'cancelled' : 'failed'
        run.error = { ...serializeError(error), failureClass: classifyFailure(error) }
        run.completedAt = nowIso()
        await this.finalize(run, runDir, onUpdate)
      })
      .finally(() => this.active.delete(id))
    this.active.get(id).promise = promise
    return { id, run }
  }

  cancel(id) {
    const active = this.active.get(id)
    if (!active) return false
    active.controller.abort(new Error('cancelled by user'))
    return true
  }

  async execute(run, runDir, config, signal, onUpdate) {
    run.phase = 'endpoint-discovery'
    run.discovery = await discoverModels(config, signal)
    run.model = config.model === 'auto' ? run.discovery.models[0] || null : config.model
    if (!run.model) throw new Error('Model ID is required because /models returned no usable model')
    await this.persist(run, runDir, onUpdate)

    run.phase = 'protocol-probe'
    run.protocolProbe = await probeProtocol(config, run.model, signal)
    if (!run.protocolProbe.ok) {
      const error = new Error('No supported API protocol passed the probe')
      error.code = 'PROTOCOL_COMPAT'
      throw error
    }
    run.protocol = run.protocolProbe.protocol
    await this.persist(run, runDir, onUpdate)

    for (const row of run.cases) {
      if (signal.aborted) throw signal.reason || new Error('aborted')
      run.phase = row.id
      row.status = 'running'
      row.startedAt = nowIso()
      await this.persist(run, runDir, onUpdate)
      try {
        if (row.id === 'instruction-exact') await this.caseExact(row, config, run, signal)
        else if (row.id === 'instruction-json') await this.caseJson(row, config, run, signal)
        else if (row.id === 'tool-call') await this.caseTool(row, config, run, signal)
        else if (row.id === 'latency-sample') await this.casePerformance(row, config, run, signal)
        else if (row.category === 'context') await this.caseContext(row, config, run, signal)
        else if (row.id === 'dsh-agent-file') await this.caseDshFile(row, config, run, runDir, signal)
        else if (row.id === 'dsh-agent-recovery') await this.caseDshRecovery(row, config, run, runDir, signal)
        else if (row.id === 'dsh-agent-media') await this.caseDshMedia(row, config, run, runDir, signal)
        else { row.status = 'skipped'; row.message = 'No evaluator registered for this case.' }
      } catch (error) {
        row.status = 'failed'
        row.failureClass = classifyFailure(error)
        row.message = error?.message || String(error)
        row.detail = { error: serializeError(error) }
      }
      row.completedAt = nowIso()
      await this.persist(run, runDir, onUpdate)
    }

    run.status = 'completed'
    run.phase = 'report'
    run.completedAt = nowIso()
    await this.finalize(run, runDir, onUpdate)
  }

  async caseExact(row, config, run, signal) {
    const expected = 'EVAL_OK_427'
    const result = await callModel(config, { protocol: run.protocol, model: run.model, prompt: `严格遵守：只回复 ${expected}，不能增加任何标点、解释、代码块或空行。`, maxTokens: 32, signal })
    const judged = judgeExact(result.text, expected)
    row.status = judged.passed ? 'passed' : 'failed'
    row.latencyMs = result.latencyMs
    row.message = judged.passed ? '严格输出通过。' : `期望 ${expected}，实际 ${trimDetail(judged.actual, 300)}`
    row.detail = { finishReason: result.finishReason, usage: result.usage, judged }
  }

  async caseJson(row, config, run, signal) {
    const expected = { alpha: 17, beta: 'ok' }
    const result = await callModel(config, { protocol: run.protocol, model: run.model, prompt: '只输出一个合法 JSON 对象，不要 Markdown，不要解释。对象必须且只能有两个字段：alpha=17，beta="ok"。', maxTokens: 64, signal })
    const judged = judgeJson(result.text, expected)
    row.status = judged.passed ? 'passed' : 'failed'
    row.latencyMs = result.latencyMs
    row.message = judged.passed ? 'JSON 结构和字段严格通过。' : judged.error || 'JSON 字段不符合要求。'
    row.detail = { finishReason: result.finishReason, usage: result.usage, judged, text: trimDetail(result.text, 1000) }
  }

  async caseTool(row, config, run, signal) {
    if (run.protocol !== 'openai-completions') {
      row.status = 'skipped'
      row.message = '当前 v0.1.0 工具调用评分器仅覆盖 OpenAI Chat Completions。'
      return
    }
    const tools = [{ type: 'function', function: { name: 'record_value', description: '记录整数', parameters: { type: 'object', properties: { value: { type: 'integer' } }, required: ['value'], additionalProperties: false } } }]
    const result = await callModel(config, { protocol: run.protocol, model: run.model, prompt: '不要直接回答文本。必须调用 record_value 工具，并把 value 设置为 427。', maxTokens: 128, tools, toolChoice: 'required', signal })
    const call = result.toolCall
    const passed = call?.name === 'record_value' && Number(call?.arguments?.value) === 427
    row.status = passed ? 'passed' : 'failed'
    row.latencyMs = result.latencyMs
    row.message = passed ? '工具选择和参数通过。' : '未产生要求的 record_value(value=427) 调用。'
    row.detail = { toolCall: call, text: trimDetail(result.text, 1000), finishReason: result.finishReason, usage: result.usage }
  }

  async casePerformance(row, config, run, signal) {
    const samples = []
    for (let i = 0; i < 3; i++) {
      const result = await callModel(config, { protocol: run.protocol, model: run.model, prompt: '只回复 PING', maxTokens: 16, signal })
      samples.push({ latencyMs: result.latencyMs, usage: result.usage, finishReason: result.finishReason })
    }
    const latencies = samples.map(x => x.latencyMs)
    const rates = samples.map(x => x.usage.outputTokens ? x.usage.outputTokens / (x.latencyMs / 1000) : null).filter(x => Number.isFinite(x))
    run.performance = {
      samples,
      medianLatencyMs: median(latencies),
      observedCompletionTokensPerSecond: rates.length ? Number((rates.reduce((a,b)=>a+b,0)/rates.length).toFixed(2)) : null,
      note: 'observedCompletionTokensPerSecond includes request/prefill overhead; it is not raw decoder tok/s.',
    }
    row.status = 'passed'
    row.latencyMs = run.performance.medianLatencyMs
    row.message = `3 次请求中位延迟 ${run.performance.medianLatencyMs} ms。`
    row.detail = run.performance
  }

  async caseContext(row, config, run, signal) {
    const tokens = row.estimatedTokens || 4096
    const sentinel = `CTX_${tokens}_RIVER_9427`
    const prompt = makeContextPrompt(tokens, sentinel)
    const result = await callModel(config, { protocol: run.protocol, model: run.model, prompt, maxTokens: 64, signal })
    const actual = result.text.trim().replace(/^['"`]+|['"`]+$/g, '')
    const passed = actual.includes(sentinel)
    row.status = passed ? 'passed' : 'failed'
    row.latencyMs = result.latencyMs
    row.message = passed ? `约 ${Math.round(tokens/1024)}K Token 召回通过。` : `未召回 sentinel；输出：${trimDetail(actual, 300)}`
    row.detail = { estimatedTokens: tokens, promptChars: prompt.length, sentinel, output: trimDetail(result.text, 1000), usage: result.usage, finishReason: result.finishReason }
  }

  async dshAvailable() {
    const result = await runPython({ action: 'probe' }, { timeoutMs: 15000 })
    return result.result || { ok: false, error: result.stderr || result.stdout || `python exit ${result.code}` }
  }

  async runDsh(row, config, run, runDir, workspace, prompt, signal) {
    if (!config.runDshAgent) {
      row.status = 'skipped'
      row.message = 'DSH Agent tests disabled by run configuration.'
      return null
    }
    const available = await this.dshAvailable()
    if (!available.ok) {
      row.status = 'skipped'
      row.failureClass = 'DSH_SDK_UNAVAILABLE'
      row.message = `DeepSeek Harness Python SDK unavailable: ${available.error || 'unknown error'}`
      row.detail = available
      return null
    }
    const dshHome = join(runDir, 'dsh-home', row.id)
    const payload = {
      action: 'run',
      dshHome,
      cwd: workspace,
      profile: config.dshProfile,
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      protocol: run.protocol,
      declaredContext: config.declaredContext,
      model: run.model,
      reasoningEffort: config.reasoningEffort,
      maxTokens: 8192,
      requestTimeoutSeconds: Math.max(60, Math.ceil(config.timeoutMs / 1000)),
      sessionId: `${run.id}-${row.id}`,
      prompt,
    }
    const started = performance.now()
    const result = await runPython(payload, { timeoutMs: Math.max(5 * 60_000, config.timeoutMs * 4), signal })
    row.latencyMs = Math.round(performance.now() - started)
    if (!result.result) {
      throw new Error(`DSH SDK runner returned no structured result (exit ${result.code}): ${trimDetail(result.stderr || result.stdout, 2000)}`)
    }
    if (!result.result.ok) {
      const error = new Error(result.result.error || 'DSH SDK run failed')
      error.code = result.result.code || 'DSH_RUNTIME_FAILURE'
      throw error
    }
    row.detail = {
      finishReason: result.result.finishReason,
      finalResponse: trimDetail(result.result.finalResponse, 4000),
      events: result.result.eventCount,
      notifications: result.result.notificationCount,
      runtimeStderr: trimDetail(result.stderr, 1500),
    }
    return result.result
  }

  async caseDshFile(row, config, run, runDir, signal) {
    const workspace = join(runDir, 'workspaces', row.id)
    await mkdir(join(workspace, 'deliverables'), { recursive: true })
    await writeFile(join(workspace, 'TASK.md'), '# Task\nCreate the requested deliverables. The evaluator owns hidden acceptance checks.\n')
    const prompt = `你在一个隔离的模型评测 workspace 中。完成任务并自己检查结果：\n1. 创建 deliverables/result.md，正文必须包含独立一行 DSH_AGENT_ARTIFACT_OK_427。\n2. 创建 deliverables/diagram.svg，必须是可打开的 SVG，并在图中出现文字 MODEL EVAL 427。\n3. 不要修改 TASK.md。\n4. 完成后检查两个文件真实存在，再回复 DONE。`
    const dsh = await this.runDsh(row, config, run, runDir, workspace, prompt, signal)
    if (!dsh) return
    const md = await readFile(join(workspace, 'deliverables', 'result.md'), 'utf8').catch(() => '')
    const svg = await readFile(join(workspace, 'deliverables', 'diagram.svg'), 'utf8').catch(() => '')
    const passed = /(^|\n)DSH_AGENT_ARTIFACT_OK_427(\n|$)/.test(md) && /<svg\b/i.test(svg) && /MODEL\s*EVAL\s*427/i.test(svg)
    row.artifacts = await collectArtifacts({ sourceDir: join(workspace, 'deliverables'), runDir, caseId: row.id })
    row.status = passed ? 'passed' : 'failed'
    row.message = passed ? `DSH Agent 真实文件交付通过，收集 ${row.artifacts.length} 个产物。` : 'DSH Agent 结束，但隐藏文件验收未通过。'
    row.detail = { ...(row.detail || {}), hiddenCheck: { markdownSentinel: /DSH_AGENT_ARTIFACT_OK_427/.test(md), validSvg: /<svg\b/i.test(svg), svgText: /MODEL\s*EVAL\s*427/i.test(svg) } }
  }

  async caseDshRecovery(row, config, run, runDir, signal) {
    const workspace = join(runDir, 'workspaces', row.id)
    await mkdir(join(workspace, 'deliverables'), { recursive: true })
    await writeFile(join(workspace, 'calc.py'), 'def multiply(a, b):\n    return a + b\n')
    await writeFile(join(workspace, 'test_calc.py'), 'from calc import multiply\nassert multiply(6, 7) == 42\nassert multiply(-3, 5) == -15\nprint("RECOVERY_TEST_OK")\n')
    const prompt = `这是无人值守恢复能力测试。当前目录有 calc.py 和 test_calc.py，测试会失败。\n目标：定位问题并修复 calc.py，使 python3 test_calc.py 通过；禁止修改 test_calc.py。\n必须亲自运行测试确认。最后创建 deliverables/recovery.md，写清修复结果并包含 RECOVERY_DONE_427，然后回复 DONE。`
    const dsh = await this.runDsh(row, config, run, runDir, workspace, prompt, signal)
    if (!dsh) return
    const check = await runPython({ action: 'command', cwd: workspace, argv: ['python3', 'test_calc.py'] }, { timeoutMs: 30000, signal })
    const note = await readFile(join(workspace, 'deliverables', 'recovery.md'), 'utf8').catch(() => '')
    const passed = check.result?.ok && /RECOVERY_TEST_OK/.test(check.result.stdout || '') && /RECOVERY_DONE_427/.test(note)
    row.artifacts = await collectArtifacts({ sourceDir: join(workspace, 'deliverables'), runDir, caseId: row.id })
    row.status = passed ? 'passed' : 'failed'
    row.message = passed ? '失败定位、修复、重测和交付通过。' : 'Agent 运行结束，但外部隐藏重测未通过。'
    row.detail = { ...(row.detail || {}), hiddenCommand: check.result || { code: check.code, stderr: trimDetail(check.stderr, 1000) }, recoveryNoteSentinel: /RECOVERY_DONE_427/.test(note) }
  }


  async caseDshMedia(row, config, run, runDir, signal) {
    const preflight = await runPython({ action: 'command', cwd: runDir, argv: ['ffmpeg', '-version'] }, { timeoutMs: 15000, signal })
    if (!preflight.result?.ok) {
      row.status = 'skipped'
      row.failureClass = 'ENVIRONMENT_CAPABILITY_MISSING'
      row.message = '当前评测 Host 没有可用 ffmpeg，视频交付 Case 跳过；图片和文档产物仍会正常评测。'
      row.detail = preflight.result || { stderr: trimDetail(preflight.stderr, 1000) }
      return
    }
    const workspace = join(runDir, 'workspaces', row.id)
    await mkdir(join(workspace, 'deliverables'), { recursive: true })
    const prompt = `这是 DSH 多媒体交付测试。当前机器已确认存在 ffmpeg。\n1. 使用本机工具生成 deliverables/model-eval-427.mp4，要求 MP4 可正常播放，至少 1 秒，分辨率至少 320x180。内容可使用 testsrc/color 等合成源，不需要联网素材。\n2. 创建 deliverables/media.md，必须包含 MEDIA_DELIVERY_OK_427，并说明你实际使用的生成命令。\n3. 亲自用 ffprobe 或 ffmpeg 检查生成文件可读取后再结束。\n4. 最后回复 DONE。`
    const dsh = await this.runDsh(row, config, run, runDir, workspace, prompt, signal)
    if (!dsh) return
    const media = join(workspace, 'deliverables', 'model-eval-427.mp4')
    const probe = await runPython({ action: 'command', cwd: workspace, argv: ['ffprobe', '-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height', '-of', 'json', media] }, { timeoutMs: 30000, signal })
    const note = await readFile(join(workspace, 'deliverables', 'media.md'), 'utf8').catch(() => '')
    let probeJson = null
    try { probeJson = JSON.parse(probe.result?.stdout || '') } catch {}
    const videoStream = probeJson?.streams?.find?.(x => x.codec_type === 'video')
    const duration = Number(probeJson?.format?.duration || 0)
    const passed = Boolean(probe.result?.ok && videoStream && duration >= 1 && Number(videoStream.width) >= 320 && Number(videoStream.height) >= 180 && /MEDIA_DELIVERY_OK_427/.test(note))
    row.artifacts = await collectArtifacts({ sourceDir: join(workspace, 'deliverables'), runDir, caseId: row.id })
    row.status = passed ? 'passed' : 'failed'
    row.message = passed ? `视频交付通过：${videoStream.width}x${videoStream.height}，${duration.toFixed(2)}s；报告可直接播放。` : '视频产物存在性/可播放性/尺寸/说明文档隐藏验收未全部通过。'
    row.detail = { ...(row.detail || {}), ffprobe: probeJson || probe.result, mediaNoteSentinel: /MEDIA_DELIVERY_OK_427/.test(note) }
  }

  async persist(run, runDir, onUpdate) {
    run.summary = scoreCases(run.cases)
    run.categories = byCategory(run.cases)
    await writeJson(join(runDir, 'run.json'), run)
    try { onUpdate?.(structuredClone(run)) } catch {}
  }

  async finalize(run, runDir, onUpdate) {
    run.summary = scoreCases(run.cases)
    run.categories = byCategory(run.cases)
    await writeReports(run, runDir)
    await this.persist(run, runDir, onUpdate)
  }
}
