import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { copyFile, mkdir, readdir, stat } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { artifactKind, mimeOf, safeId } from './core.js'

const MAX_ARTIFACTS = 200
const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024

export function inside(root, candidate) {
  const r = resolve(root)
  const c = resolve(candidate)
  return c === r || c.startsWith(r + sep)
}

async function sha256(path) {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash)
  return hash.digest('hex')
}

async function walk(root, current = root, out = []) {
  if (out.length >= MAX_ARTIFACTS) return out
  let rows
  try { rows = await readdir(current, { withFileTypes: true }) } catch { return out }
  for (const row of rows) {
    if (out.length >= MAX_ARTIFACTS) break
    const path = join(current, row.name)
    if (row.isDirectory()) await walk(root, path, out)
    else if (row.isFile()) out.push(path)
  }
  return out
}

export async function collectArtifacts({ sourceDir, runDir, caseId }) {
  const info = await stat(sourceDir).catch(() => null)
  if (!info?.isDirectory()) return []
  const files = await walk(sourceDir)
  const targetRoot = join(runDir, 'artifacts', safeId(caseId))
  await mkdir(targetRoot, { recursive: true })
  const artifacts = []
  for (const source of files) {
    const s = await stat(source).catch(() => null)
    if (!s?.isFile() || s.size > MAX_ARTIFACT_BYTES) continue
    const rel = relative(sourceDir, source)
    const target = join(targetRoot, rel)
    if (!inside(targetRoot, target)) continue
    await mkdir(dirname(target), { recursive: true })
    await copyFile(source, target)
    artifacts.push({
      caseId,
      name: basename(source),
      kind: artifactKind(source),
      mime: mimeOf(source),
      bytes: s.size,
      sha256: await sha256(target),
      path: relative(runDir, target).split(sep).join('/'),
      sourceRelativePath: rel.split(sep).join('/'),
    })
  }
  return artifacts
}

export function publicArtifactUrl(runId, artifactPath) {
  return `/plugins/dsh-model-eval/artifact?run=${encodeURIComponent(runId)}&path=${encodeURIComponent(artifactPath)}`
}
