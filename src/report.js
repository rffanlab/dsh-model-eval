import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { byCategory, scoreCases } from './core.js'

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[ch]))
}

function pct(value) {
  return value == null ? 'N/A' : `${(value * 100).toFixed(1)}%`
}

function statusIcon(status) {
  return status === 'passed' ? '✅' : status === 'failed' ? '❌' : status === 'skipped' ? '⏭️' : '⏳'
}

function servedPath(run, path) {
  return `/plugins/dsh-model-eval/file?run=${encodeURIComponent(run.id)}&path=${encodeURIComponent(path)}`
}

function artifactHtml(run, artifact) {
  const src = servedPath(run, artifact.path)
  const caption = `<div class="artifact-meta"><strong>${esc(artifact.name)}</strong><span>${esc(artifact.kind)} · ${(artifact.bytes / 1024).toFixed(1)} KB</span></div>`
  if (artifact.kind === 'image') return `<figure class="artifact">${caption}<a href="${src}" target="_blank"><img loading="lazy" src="${src}" alt="${esc(artifact.name)}"></a></figure>`
  if (artifact.kind === 'video') return `<figure class="artifact">${caption}<video controls preload="metadata" src="${src}"></video><a href="${src}" target="_blank">打开原文件</a></figure>`
  if (artifact.kind === 'audio') return `<figure class="artifact">${caption}<audio controls preload="metadata" src="${src}"></audio><a href="${src}" target="_blank">打开原文件</a></figure>`
  if (artifact.mime === 'application/pdf') return `<figure class="artifact artifact-doc">${caption}<iframe loading="lazy" src="${src}"></iframe><a href="${src}" target="_blank">打开 PDF</a></figure>`
  return `<figure class="artifact artifact-doc">${caption}<a class="doc-link" href="${src}" target="_blank">📄 打开 / 下载文档</a></figure>`
}

function summarySvg(run) {
  const summary = scoreCases(run.cases)
  const cats = Object.entries(byCategory(run.cases))
  const width = 900
  const height = 150 + cats.length * 42
  const lines = cats.map(([name, s], i) => {
    const y = 118 + i * 42
    const rate = s.passRate ?? 0
    const bar = Math.round(rate * 620)
    return `<text x="24" y="${y}" font-size="17" fill="#222">${esc(name)}</text><rect x="190" y="${y-16}" width="620" height="20" rx="10" fill="#e9e9e9"/><rect x="190" y="${y-16}" width="${bar}" height="20" rx="10" fill="#333"/><text x="824" y="${y}" font-size="16" fill="#222">${esc(pct(s.passRate))}</text>`
  }).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="white"/><text x="24" y="42" font-size="26" font-family="sans-serif" font-weight="700">DSH Model Eval · ${esc(run.model || 'unknown')}</text><text x="24" y="75" font-size="17" font-family="sans-serif" fill="#555">${esc(run.id)} · ${esc(run.config?.suite || '')} · pass ${esc(pct(summary.passRate))}</text><g font-family="sans-serif">${lines}</g></svg>`
}

export function renderMarkdown(run) {
  const summary = scoreCases(run.cases)
  const categories = byCategory(run.cases)
  const lines = [
    `# DSH Model Evaluation Report`, '',
    `- Run: \`${run.id}\``,
    `- Model: \`${run.model || 'unknown'}\``,
    `- Endpoint: \`${run.config?.baseUrl || ''}\``,
    `- Protocol: \`${run.protocol || 'unknown'}\``,
    `- Suite: \`${run.config?.suite || ''}\``,
    `- Status: **${run.status}**`,
    `- Pass rate: **${pct(summary.passRate)}** (${summary.passed}/${summary.scored})`, '',
    `![Evaluation summary](summary.svg)`, '',
    `## Capability summary`, '',
    `| Category | Passed | Failed | Skipped | Pass rate |`,
    `|---|---:|---:|---:|---:|`,
  ]
  for (const [category, s] of Object.entries(categories)) lines.push(`| ${category} | ${s.passed} | ${s.failed} | ${s.skipped} | ${pct(s.passRate)} |`)
  lines.push('', '## Cases', '')
  for (const row of run.cases) {
    lines.push(`### ${statusIcon(row.status)} ${row.title}`, '', `- ID: \`${row.id}\``, `- Category: \`${row.category}\``, `- Status: **${row.status}**`)
    if (row.latencyMs != null) lines.push(`- Latency: ${row.latencyMs} ms`)
    if (row.message) lines.push(`- Note: ${row.message}`)
    if (row.failureClass) lines.push(`- Failure class: \`${row.failureClass}\``)
    if (row.artifacts?.length) {
      lines.push('', 'Artifacts:')
      for (const a of row.artifacts) lines.push(`- [${a.name}](${a.path}) — ${a.kind}, ${a.bytes} bytes`)
    }
    lines.push('')
  }
  if (run.protocolProbe) lines.push('## Protocol probe', '', '```json', JSON.stringify(run.protocolProbe, null, 2), '```', '')
  if (run.performance) lines.push('## Performance', '', '```json', JSON.stringify(run.performance, null, 2), '```', '')
  return lines.join('\n')
}

export function renderHtml(run) {
  const summary = scoreCases(run.cases)
  const categories = byCategory(run.cases)
  const cards = Object.entries(categories).map(([name, s]) => `<div class="metric"><span>${esc(name)}</span><strong>${esc(pct(s.passRate))}</strong><small>${s.passed}/${s.scored} passed</small></div>`).join('')
  const caseRows = run.cases.map(row => {
    const artifacts = (row.artifacts || []).map(artifact => artifactHtml(run, artifact)).join('')
    const detail = row.detail ? `<details><summary>原始详情</summary><pre>${esc(JSON.stringify(row.detail, null, 2))}</pre></details>` : ''
    return `<section class="case"><header><span class="status">${statusIcon(row.status)}</span><div><h3>${esc(row.title)}</h3><div class="muted">${esc(row.id)} · ${esc(row.category)}${row.latencyMs != null ? ` · ${row.latencyMs} ms` : ''}</div></div></header>${row.message ? `<p>${esc(row.message)}</p>` : ''}${row.failureClass ? `<p><code>${esc(row.failureClass)}</code></p>` : ''}${detail}${artifacts ? `<div class="artifacts">${artifacts}</div>` : ''}</section>`
  }).join('')
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>DSH Model Eval · ${esc(run.model)}</title><style>
:root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#1f2328;background:#f7f7f8}body{margin:0}.wrap{max-width:1180px;margin:auto;padding:28px}.hero,.case,.metric{background:white;border:1px solid #e4e4e7;border-radius:14px}.hero{padding:24px}.hero h1{margin:0 0 8px}.muted{color:#6b7280;font-size:13px}.score{font-size:44px;font-weight:800;margin:18px 0}.metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin:16px 0}.metric{padding:14px;display:grid;gap:4px}.metric strong{font-size:24px}.metric small{color:#6b7280}.summary-img{max-width:100%;background:white;border-radius:12px;border:1px solid #e4e4e7;margin:8px 0 20px}.case{padding:18px;margin:14px 0}.case header{display:flex;gap:12px;align-items:flex-start}.case h3{margin:0 0 4px}.status{font-size:24px}pre{white-space:pre-wrap;word-break:break-word;background:#111827;color:#e5e7eb;padding:14px;border-radius:10px;overflow:auto}.artifacts{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px;margin-top:14px}.artifact{margin:0;border:1px solid #e5e7eb;border-radius:12px;padding:10px;display:grid;gap:8px;background:#fafafa}.artifact img,.artifact video{width:100%;max-height:420px;object-fit:contain;border-radius:8px;background:#111}.artifact audio{width:100%}.artifact iframe{width:100%;height:420px;border:0;background:white}.artifact-meta{display:flex;justify-content:space-between;gap:8px;font-size:12px}.artifact-meta span{color:#6b7280}.doc-link{display:block;padding:28px;text-align:center;background:white;border-radius:8px;text-decoration:none}code{background:#f0f0f2;padding:2px 5px;border-radius:5px}a{color:inherit}@media(max-width:640px){.wrap{padding:14px}.score{font-size:34px}}
</style></head><body><main class="wrap"><section class="hero"><h1>DSH Model Evaluation Report</h1><div class="muted">${esc(run.id)} · ${esc(run.config?.suite)} · ${esc(run.protocol || 'protocol unknown')}</div><div class="score">${esc(pct(summary.passRate))}</div><div><strong>${esc(run.model || 'unknown')}</strong></div><div class="muted">${esc(run.config?.baseUrl || '')}</div></section><div class="metrics">${cards}</div><img class="summary-img" src="${servedPath(run, 'summary.svg')}" alt="evaluation summary">${caseRows}</main></body></html>`
}

export async function writeReports(run, runDir) {
  await mkdir(runDir, { recursive: true })
  await writeFile(join(runDir, 'report.md'), renderMarkdown(run))
  await writeFile(join(runDir, 'report.html'), renderHtml(run))
  await writeFile(join(runDir, 'summary.svg'), summarySvg(run))
  await writeFile(join(runDir, 'model-card.json'), JSON.stringify({
    schemaVersion: 1,
    runId: run.id,
    model: run.model,
    protocol: run.protocol,
    endpoint: run.config?.baseUrl,
    suite: run.config?.suite,
    score: scoreCases(run.cases),
    categories: byCategory(run.cases),
    performance: run.performance || null,
    completedAt: run.completedAt || null,
  }, null, 2))
}
