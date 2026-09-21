import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EvalEngine } from '../src/engine.js'

function fakeServer() {
  return http.createServer(async (req,res)=>{
    if(req.method==='GET' && req.url==='/v1/models') {
      res.setHeader('content-type','application/json');res.end(JSON.stringify({data:[{id:'fake-model'}]}));return
    }
    if(req.method==='POST' && req.url==='/v1/chat/completions') {
      let raw='';for await(const chunk of req) raw+=chunk
      const body=JSON.parse(raw||'{}')
      const prompt=body.messages?.at(-1)?.content||''
      let message={role:'assistant',content:'OK'}
      let finish='stop'
      if(body.tools) { message={role:'assistant',content:'',tool_calls:[{id:'c1',type:'function',function:{name:'record_value',arguments:'{"value":427}'}}]};finish='tool_calls' }
      else if(prompt.includes('MODEL_EVAL_PROTOCOL_OK')) message.content='MODEL_EVAL_PROTOCOL_OK'
      else if(prompt.includes('EVAL_OK_427')) message.content='EVAL_OK_427'
      else if(prompt.includes('alpha=17')) message.content='{"alpha":17,"beta":"ok"}'
      else if(prompt.includes('只回复 PING')) message.content='PING'
      else if(prompt.includes('KEY=')) { const m=/KEY=(CTX_[A-Z0-9_]+)/.exec(prompt);message.content=m?m[1]:'MISSING' }
      const value={id:'fake',choices:[{index:0,message,finish_reason:finish}],usage:{prompt_tokens:100,completion_tokens:2,total_tokens:102}}
      res.setHeader('content-type','application/json');res.end(JSON.stringify(value));return
    }
    res.statusCode=404;res.end(JSON.stringify({error:{message:'not found'}}))
  })
}

test('engine performs end-to-end standard evaluation and writes reports', async t => {
  const root=await mkdtemp(join(tmpdir(),'dsh-eval-test-'))
  t.after(()=>rm(root,{recursive:true,force:true}))
  const server=fakeServer()
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  t.after(()=>server.close())
  const port=server.address().port
  const engine=new EvalEngine({rootDir:root})
  const {id}=await engine.start({baseUrl:`http://127.0.0.1:${port}/v1`,model:'auto',suite:'standard',runDshAgent:false,timeoutMs:5000})
  const active=engine.active.get(id)
  if(active?.promise) await active.promise
  const run=JSON.parse(await readFile(join(root,id,'run.json'),'utf8'))
  assert.equal(run.status,'completed')
  assert.equal(run.model,'fake-model')
  assert.equal(run.protocol,'openai-completions')
  assert.equal(run.cases.find(x=>x.id==='instruction-exact').status,'passed')
  assert.equal(run.cases.find(x=>x.id==='tool-call').status,'passed')
  assert.equal(run.cases.find(x=>x.id==='context-4k').status,'passed')
  assert.equal(run.cases.find(x=>x.id==='dsh-agent-file').status,'skipped')
  assert.match(await readFile(join(root,id,'report.html'),'utf8'),/DSH Model Evaluation Report/)
  assert.match(await readFile(join(root,id,'summary.svg'),'utf8'),/<svg/)
})
