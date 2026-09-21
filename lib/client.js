(() => {
  const ID = 'dsh-model-eval'
  window.__ModuleLoader__.load({
    id: ID,
    factory(require) {
      const React = require('react')
      const h = React.createElement
      const API = '/plugins/dsh-model-eval/api'
      const REPORT = '/plugins/dsh-model-eval/report'

      const input = { width:'100%',minHeight:36,border:'1px solid color-mix(in srgb,currentColor 18%,transparent)',borderRadius:8,background:'transparent',color:'inherit',padding:'0 9px',boxSizing:'border-box' }
      const button = { minHeight:36,border:'1px solid color-mix(in srgb,currentColor 18%,transparent)',borderRadius:8,background:'transparent',color:'inherit',padding:'0 13px',cursor:'pointer' }
      const card = { border:'1px solid color-mix(in srgb,currentColor 15%,transparent)',borderRadius:12,padding:14 }

      async function api(action, extra = {}) {
        const response = await fetch(API, { method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action,...extra}) })
        const value = await response.json()
        if (!response.ok || !value.ok) throw new Error(value.error || `HTTP ${response.status}`)
        return value
      }

      function pct(v) { return v == null ? '—' : `${(v*100).toFixed(1)}%` }
      function statusIcon(v) { return v === 'passed' ? '✅' : v === 'failed' ? '❌' : v === 'skipped' ? '⏭️' : v === 'running' ? '▶️' : '○' }

      function Field({label,hint,children}) {
        return h('label',{style:{display:'grid',gap:5}},[h('span',{key:'l',style:{fontSize:13,fontWeight:650}},label),children,hint?h('span',{key:'h',style:{fontSize:12,opacity:.65}},hint):null])
      }

      function RunSummary({run}) {
        if (!run) return null
        const summary = run.summary || {}
        return h('div',{style:{...card,display:'grid',gap:10}},[
          h('div',{key:'top',style:{display:'flex',gap:12,alignItems:'center',flexWrap:'wrap'}},[
            h('strong',{key:'model',style:{fontSize:18}},run.model || '正在发现模型…'),
            h('span',{key:'status',style:{opacity:.7}},run.status),
            h('span',{key:'phase',style:{opacity:.7}},run.phase || ''),
            h('strong',{key:'score',style:{marginLeft:'auto',fontSize:24}},pct(summary.passRate)),
          ]),
          h('div',{key:'meta',style:{fontSize:12,opacity:.65}},`${run.protocol || '协议探测中'} · ${run.config?.suite || ''} · ${run.id}`),
          h('div',{key:'cases',style:{display:'grid',gap:6}},(run.cases||[]).map(row=>h('div',{key:row.id,style:{display:'grid',gridTemplateColumns:'28px minmax(0,1fr) auto',gap:8,alignItems:'center',fontSize:13}},[
            h('span',{key:'i'},statusIcon(row.status)),
            h('span',{key:'t',style:{minWidth:0}},row.title),
            h('span',{key:'m',style:{opacity:.6,fontSize:12}},row.latencyMs!=null?`${row.latencyMs}ms`:row.status),
          ]))),
          run.status !== 'running' ? h('div',{key:'actions',style:{display:'flex',gap:8,flexWrap:'wrap'}},[
            h('a',{key:'report',href:`${REPORT}?run=${encodeURIComponent(run.id)}`,target:'_blank',style:{...button,display:'inline-flex',alignItems:'center',textDecoration:'none'}},'打开图文/视频报告'),
          ]) : null,
          run.status !== 'running' ? h('iframe',{key:'preview',title:'模型评测报告',src:`${REPORT}?run=${encodeURIComponent(run.id)}`,style:{width:'100%',height:620,border:'1px solid color-mix(in srgb,currentColor 12%,transparent)',borderRadius:10,background:'white'}}) : null,
        ])
      }

      function App() {
        const [baseUrl,setBaseUrl]=React.useState('http://127.0.0.1:8001/v1')
        const [apiKey,setApiKey]=React.useState('')
        const [model,setModel]=React.useState('auto')
        const [suite,setSuite]=React.useState('standard')
        const [context,setContext]=React.useState('')
        const [run,setRun]=React.useState(null)
        const [runs,setRuns]=React.useState([])
        const [busy,setBusy]=React.useState(false)
        const [message,setMessage]=React.useState('')
        const timer=React.useRef(null)

        const loadRuns=React.useCallback(async()=>{ try{ const v=await api('list'); setRuns(v.runs||[]) }catch{} },[])
        React.useEffect(()=>{ void loadRuns(); return()=>{if(timer.current)clearInterval(timer.current)} },[loadRuns])

        const poll=id=>{
          if(timer.current) clearInterval(timer.current)
          const tick=async()=>{
            try{
              const v=await api('status',{id}); setRun(v.run)
              if(v.run.status!=='running') { clearInterval(timer.current);timer.current=null;setBusy(false);void loadRuns() }
            }catch(error){setMessage(`❌ ${error.message}`);setBusy(false);clearInterval(timer.current);timer.current=null}
          }
          void tick();timer.current=setInterval(tick,1800)
        }

        const start=async()=>{
          setBusy(true);setMessage('正在创建隔离评测 Run…')
          try{
            const v=await api('start',{config:{baseUrl,apiKey,model,suite,declaredContext:context||undefined,runDshAgent:true}})
            setRun(v.run);setMessage('评测已启动。API Key 只用于本次 Host 请求，不写入报告。');poll(v.id)
          }catch(error){setBusy(false);setMessage(`❌ ${error.message}`)}
        }

        const cancel=async()=>{ if(!run?.id)return; await api('cancel',{id:run.id});setMessage('已请求取消。') }
        const openRun=async id=>{ const v=await api('status',{id});setRun(v.run);if(v.run.status==='running'){setBusy(true);poll(id)} }

        return h('div',{style:{display:'grid',gap:14,padding:2}},[
          h('div',{key:'head'},[h('h3',{style:{margin:'0 0 6px'}},'模型自动评测'),h('div',{style:{fontSize:12,opacity:.7}},'给一个模型 API，自动完成协议探测、固定能力题、长上下文、DSH Agent 隐藏验收、性能记录和多媒体产物报告。')]),
          h('section',{key:'form',style:{...card,display:'grid',gap:12}},[
            h(Field,{key:'url',label:'API Base URL',hint:'例如 http://127.0.0.1:8001/v1'},h('input',{style:input,value:baseUrl,disabled:busy,onChange:e=>setBaseUrl(e.currentTarget.value)})),
            h('div',{key:'grid',style:{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(210px,1fr))',gap:10}},[
              h(Field,{key:'key',label:'API Key',hint:'无鉴权可留空或填 EMPTY'},h('input',{style:input,type:'password',value:apiKey,disabled:busy,autoComplete:'off',onChange:e=>setApiKey(e.currentTarget.value)})),
              h(Field,{key:'model',label:'Model ID',hint:'auto 会先调用 /models'},h('input',{style:input,value:model,disabled:busy,onChange:e=>setModel(e.currentTarget.value)})),
              h(Field,{key:'suite',label:'评测级别'},h('select',{style:input,value:suite,disabled:busy,onChange:e=>setSuite(e.currentTarget.value)},[
                h('option',{key:'smoke',value:'smoke'},'Smoke · 快速连通性'),
                h('option',{key:'standard',value:'standard'},'Standard · 日常模型比较'),
                h('option',{key:'full',value:'full'},'Full · 长上下文 + 恢复能力'),
              ])),
              h(Field,{key:'ctx',label:'声明 Context（可选）',hint:'例如 131072；Full 不会主动超过此值'},h('input',{style:input,inputMode:'numeric',placeholder:'自动 / 未声明',value:context,disabled:busy,onChange:e=>setContext(e.currentTarget.value)})),
            ]),
            h('div',{key:'buttons',style:{display:'flex',gap:8,flexWrap:'wrap'}},[
              h('button',{key:'start',style:button,disabled:busy,onClick:start},busy?'评测运行中…':'开始自动评测'),
              busy&&run?.id?h('button',{key:'cancel',style:button,onClick:cancel},'取消'):null,
            ]),
            message?h('div',{key:'msg',style:{fontSize:12}},message):null,
          ]),
          h(RunSummary,{key:'summary',run}),
          h('section',{key:'history',style:card},[
            h('div',{key:'title',style:{display:'flex',justifyContent:'space-between',alignItems:'center'}},[h('strong',null,'最近评测'),h('button',{style:button,onClick:loadRuns},'刷新')]),
            h('div',{key:'rows',style:{display:'grid',gap:6,marginTop:10}},runs.length?runs.map(r=>h('button',{key:r.id,style:{...button,textAlign:'left',display:'grid',gridTemplateColumns:'minmax(0,1fr) auto',gap:8},onClick:()=>openRun(r.id)},[
              h('span',{key:'a'},`${r.model||'unknown'} · ${r.suite} · ${r.status}`),h('span',{key:'b'},pct(r.summary?.passRate))
            ])):h('div',{style:{fontSize:12,opacity:.65}},'还没有历史评测。')),
          ])
        ])
      }

      const inject=['slots']
      function apply(ctx){
        ctx.slots.inject('settings.plugins.tab',()=>ctx.slots.register({name:'settings.plugins.tab',id:'model-eval',order:35,label:'模型评测',inject:()=>({})},App))
      }
      return {inject,apply}
    }
  })
})()
