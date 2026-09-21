#!/usr/bin/env node
import { resolve } from 'node:path'
import { EvalEngine } from '../src/engine.js'

function argsOf(argv) {
  const out = {}
  for (let i=0;i<argv.length;i++) {
    const key=argv[i]
    if (!key.startsWith('--')) continue
    const name=key.slice(2)
    const next=argv[i+1]
    out[name] = next && !next.startsWith('--') ? argv[++i] : true
  }
  return out
}

const a=argsOf(process.argv.slice(2))
if (!a['base-url']) {
  console.error('Usage: dsh-model-eval --base-url http://127.0.0.1:8001/v1 [--api-key EMPTY] [--model auto] [--suite standard] [--context 131072] [--output ./eval-results]')
  process.exit(2)
}
const engine=new EvalEngine({rootDir:resolve(a.output||'./eval-results')})
const {id}=await engine.start({
  baseUrl:a['base-url'],apiKey:a['api-key']||'',model:a.model||'auto',suite:a.suite||'standard',declaredContext:a.context||undefined,runDshAgent:a['no-dsh-agent']?false:true,
},run=>{
  process.stderr.write(`\r${run.status} · ${run.phase||''} · ${run.summary?.passed||0}/${run.summary?.scored||0} passed   `)
})
const active=engine.active.get(id)
if(active?.promise) await active.promise
const run=JSON.parse(await (await import('node:fs/promises')).readFile(resolve(a.output||'./eval-results',id,'run.json'),'utf8'))
process.stderr.write('\n')
console.log(JSON.stringify({id,status:run.status,model:run.model,passRate:run.summary?.passRate,report:resolve(a.output||'./eval-results',id,'report.html')},null,2))
process.exit(run.status==='completed'?0:1)
