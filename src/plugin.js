import { createReadStream } from 'node:fs'
import { mkdir, readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { artifactKind, mimeOf } from './core.js'
import { EvalEngine } from './engine.js'

export const name = 'dsh-model-eval'
export const API_PATH = '/plugins/dsh-model-eval/api'
export const REPORT_PATH = '/plugins/dsh-model-eval/report'
export const FILE_PATH = '/plugins/dsh-model-eval/file'

const MAX_BODY_BYTES = 256 * 1024

function rootFromEnvironment() {
  if (process.env.DSH_MODEL_EVAL_HOME) return resolve(process.env.DSH_MODEL_EVAL_HOME)
  const dshHome = process.env.DSH_HOME ? resolve(process.env.DSH_HOME) : join(homedir(), '.dsh')
  return join(dshHome, 'model-eval')
}

function writeJson(res, status, value) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(value))
}

async function readJson(req) {
  let total = 0
  const chunks = []
  for await (const chunk of req) {
    total += chunk.length
    if (total > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(chunk)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  return raw ? JSON.parse(raw) : {}
}

function queryOf(req) {
  return new URL(req.url || '/', 'http://localhost').searchParams
}

function safeRunId(value) {
  const id = String(value || '')
  if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error('invalid run id')
  return id
}

function safeRunFile(root, runId, relPath) {
  const runRoot = resolve(root, safeRunId(runId))
  const target = resolve(runRoot, String(relPath || ''))
  if (target !== runRoot && !target.startsWith(runRoot + sep)) throw new Error('path escapes run directory')
  return { runRoot, target }
}

async function readRun(root, id) {
  const { target } = safeRunFile(root, id, 'run.json')
  return JSON.parse(await readFile(target, 'utf8'))
}

async function listRuns(root) {
  await mkdir(root, { recursive: true })
  const entries = await readdir(root, { withFileTypes: true })
  const runs = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    try {
      const run = await readRun(root, entry.name)
      runs.push({
        id: run.id,
        status: run.status,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
        model: run.model,
        protocol: run.protocol,
        suite: run.config?.suite,
        summary: run.summary,
        phase: run.phase,
      })
    } catch {}
  }
  return runs.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt))).slice(0, 100)
}

function parseRange(header, size) {
  if (!header || !/^bytes=/i.test(header)) return null
  const match = /^bytes=(\d*)-(\d*)$/i.exec(String(header).trim())
  if (!match) return { invalid: true }
  let start, end
  if (!match[1] && match[2]) {
    const suffix = Number(match[2])
    if (!Number.isFinite(suffix) || suffix <= 0) return { invalid: true }
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(match[1])
    end = match[2] ? Number(match[2]) : size - 1
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || start >= size) return { invalid: true }
  return { start, end: Math.min(end, size - 1) }
}

function streamFile(req, res, path, info) {
  const type = mimeOf(path)
  const range = parseRange(req.headers.range, info.size)
  res.setHeader('content-type', type)
  res.setHeader('accept-ranges', 'bytes')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('x-content-type-options', 'nosniff')
  const filename = basename(path).replace(/[\r\n\0"]/g, '_')
  res.setHeader('content-disposition', `inline; filename="${filename.replace(/[^\x20-\x7E]/g, '_')}"`)
  if (range?.invalid) {
    res.statusCode = 416
    res.setHeader('content-range', `bytes */${info.size}`)
    res.end()
    return
  }
  if (range) {
    const length = range.end - range.start + 1
    res.statusCode = 206
    res.setHeader('content-range', `bytes ${range.start}-${range.end}/${info.size}`)
    res.setHeader('content-length', String(length))
    createReadStream(path, { start: range.start, end: range.end }).pipe(res)
  } else {
    res.statusCode = 200
    res.setHeader('content-length', String(info.size))
    createReadStream(path).pipe(res)
  }
}

function apiHandler(engine, root) {
  return async (req, res) => {
    if (req.method !== 'POST') return writeJson(res, 405, { ok: false, error: 'Method Not Allowed' })
    try {
      const body = await readJson(req)
      const action = body.action || 'list'
      if (action === 'start') {
        const { id, run } = await engine.start(body.config || {})
        return writeJson(res, 200, { ok: true, id, run })
      }
      if (action === 'status') return writeJson(res, 200, { ok: true, run: await readRun(root, body.id) })
      if (action === 'list') return writeJson(res, 200, { ok: true, runs: await listRuns(root) })
      if (action === 'cancel') return writeJson(res, 200, { ok: engine.cancel(body.id) })
      return writeJson(res, 400, { ok: false, error: `unknown action: ${action}` })
    } catch (error) {
      writeJson(res, 400, { ok: false, error: error?.message || String(error) })
    }
  }
}

function reportHandler(root) {
  return async (req, res) => {
    if (req.method !== 'GET') { res.statusCode = 405; res.end('Method Not Allowed'); return }
    try {
      const id = queryOf(req).get('run')
      const { target } = safeRunFile(root, id, 'report.html')
      const html = await readFile(target)
      res.statusCode = 200
      res.setHeader('content-type', 'text/html; charset=utf-8')
      res.setHeader('cache-control', 'no-store')
      res.end(html)
    } catch (error) {
      res.statusCode = 404
      res.setHeader('content-type', 'text/plain; charset=utf-8')
      res.end(error?.message || 'report not found')
    }
  }
}

function fileHandler(root) {
  return async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.statusCode = 405; res.end('Method Not Allowed'); return }
    try {
      const q = queryOf(req)
      const { target } = safeRunFile(root, q.get('run'), q.get('path'))
      const info = await stat(target)
      if (!info.isFile()) throw new Error('not a file')
      if (req.method === 'HEAD') {
        res.statusCode = 200
        res.setHeader('content-type', mimeOf(target))
        res.setHeader('content-length', String(info.size))
        res.setHeader('accept-ranges', 'bytes')
        res.end()
        return
      }
      streamFile(req, res, target, info)
    } catch (error) {
      res.statusCode = 404
      res.setHeader('content-type', 'text/plain; charset=utf-8')
      res.end(error?.message || 'file not found')
    }
  }
}

export function apply(ctx) {
  const root = rootFromEnvironment()
  const engine = new EvalEngine({ rootDir: root })
  void mkdir(root, { recursive: true })
  ctx.inject(['webServer'], webCtx => {
    webCtx.effect(() => webCtx.webServer.register({ kind: 'exact', path: API_PATH, handler: apiHandler(engine, root) }), 'dsh-model-eval: API')
    webCtx.effect(() => webCtx.webServer.register({ kind: 'exact', path: REPORT_PATH, handler: reportHandler(root) }), 'dsh-model-eval: report')
    webCtx.effect(() => webCtx.webServer.register({ kind: 'exact', path: FILE_PATH, handler: fileHandler(root) }), 'dsh-model-eval: artifact/file')
  })
}

export { EvalEngine } from './engine.js'
export { artifactKind } from './core.js'
