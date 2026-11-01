// Real Pi AgentSession + local synthetic provider/CLI; no network or user data.
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

if (!process.env.RESPIRE_SESSION_TEST_HOME) {
  const home=mkdtempSync(join(tmpdir(),'respire-session-'))
  try {
    const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>['PATH','SYSTEMROOT','WINDIR','PATHEXT','COMSPEC','TEMP','TMP'].includes(k.toUpperCase())))
    Object.assign(env,{HOME:home,USERPROFILE:home,XDG_CONFIG_HOME:join(home,'config'),XDG_DATA_HOME:join(home,'data'),RESPIRE_SESSION_TEST_HOME:home})
    execFileSync(process.execPath,[fileURLToPath(import.meta.url)],{env,stdio:'inherit',timeout:120000})
  } finally {rmSync(home,{recursive:true,force:true})}
  process.exit(0)
}

globalThis.fetch=()=>{throw Error('network forbidden in session tests')}
const { createAgentSession, AgentSessionRuntime, ModelRuntime, DefaultResourceLoader, SessionManager, SettingsManager }=await import('@earendil-works/pi-coding-agent')
const { fauxProvider, fauxAssistantMessage, fauxToolCall, InMemoryCredentialStore, InMemoryModelsStore }=await import('@earendil-works/pi-ai')
const {default:respire}=await import('../lib/index.js')
const home=process.env.RESPIRE_SESSION_TEST_HOME
const fact='Release smoke tests passed.'
const parent='abcdef12-1111-2222-3333-444455556666'
const until=async predicate=>{const end=Date.now()+20000;while(!predicate()){assert.ok(Date.now()<end,'session condition timed out');await new Promise(r=>setTimeout(r,10))}}
let count=0

async function fixture(mode) {
  const dir=mkdtempSync(join(home,'case-'));const agentDir=join(dir,'agent');mkdirSync(agentDir)
  const file=join(dir,'cli-state.json');writeFileSync(file,JSON.stringify({calls:[],writes:[],mode}))
  const script=join(dir,'rsrs.mjs')
  writeFileSync(script,`import {readFileSync,writeFileSync} from 'node:fs';
const file=${JSON.stringify(file)}, id=${JSON.stringify(parent)}, args=process.argv.slice(2);
if(args.shift()!=='--client-only'||args.pop()!=='--json')throw Error('client-only/json required');
const s=JSON.parse(readFileSync(file));s.calls.push(args);writeFileSync(file,JSON.stringify(s));
const command=args[0];let doc;
if(command==='status')doc={status:'ok',summary:{session:{has_session:true},local_alive:30,unlocked:true}};
else if(command==='list')doc={status:'ok',details:[]};
else if(command==='prompt')doc={status:'ok',summary:{instructions:'Read candidates and use a parent; never force.'}};
else if(command==='recall'){if(args.length!==5||args[2]!=='--limit'||args[3]!=='5'||args[4]!=='--titles')throw Error('invalid recall');doc={status:'ok',details:[{id,title:'Existing release policy',score:0.8}]}};
if(command==='show'){if(args.length!==2||args[1]!==id)throw Error('invalid show');doc={status:'ok',summary:{id},details:{entry:s.writes.at(-1)??{content:'Existing release policy',title:'Existing release policy'}}}};
if(command==='update'){
 if(args.length!==6||args[1]!==id||args[2]!=='--content'||args[4]!=='--title')throw Error('CLI update requires id --content text --title title');
 s.writes.push({content:args[3],title:args[5]});writeFileSync(file,JSON.stringify(s));doc={status:'ok',summary:{id}};
}
if(command==='remember'){
 if(args.length!==8||args[2]!=='--title'||args[4]!=='--importance'||args[5]!=='important'||args[6]!=='--parent'||args[7]!==id)throw Error('invalid remember');
 if(['cancel','switch','reload'].includes(s.mode)){s.writeStarted=true;writeFileSync(file,JSON.stringify(s));await new Promise(r=>setTimeout(r,10000));}
 s.writes.push({content:args[1],title:args[3]});writeFileSync(file,JSON.stringify(s));doc={status:'ok',summary:{id}};
}
if(!doc)throw Error('unsupported command');console.log(JSON.stringify(doc));`)
  let executable
  if(process.platform==='win32'){executable=join(dir,'rsrs.cmd');writeFileSync(executable,`@echo off\r\n"${process.execPath}" "${script}" %*\r\n`)}
  else{executable=join(dir,'rsrs');writeFileSync(executable,`#!${process.execPath}\n`+readFileSync(script,'utf8'),{mode:0o700})}
  const state=()=>JSON.parse(readFileSync(file,'utf8'))
  const faux=fauxProvider({models:[{id:'fixture-model',contextWindow:32000,maxTokens:4096}]})
  const runtime=await ModelRuntime.create({credentials:new InMemoryCredentialStore(),modelsStore:new InMemoryModelsStore(),modelsPath:null,allowModelNetwork:false,refreshOnCreate:false})
  runtime.registerNativeProvider(faux.provider)
  const settings=SettingsManager.inMemory({compaction:{enabled:false},retry:{enabled:false}})
  const build=async (manager, sessionStartEvent) => {
    const loader=new DefaultResourceLoader({cwd:dir,agentDir,settingsManager:settings,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,
      extensionFactories:[pi=>respire(new Proxy(pi,{get(target,key){return key==='getFlag'?name=>name==='respire-rsrs'?executable:target.getFlag(name):Reflect.get(target,key)}}))]})
    await loader.reload()
    const result=await createAgentSession({cwd:dir,agentDir,modelRuntime:runtime,model:faux.getModel(),settingsManager:settings,sessionManager:manager,resourceLoader:loader,tools:[],noTools:'all',sessionStartEvent})
    await result.session.bindExtensions({mode:'print',onError:error=>{throw Error(JSON.stringify(error))}})
    return {...result,services:{cwd:dir,agentDir,modelRuntime:runtime,settingsManager:settings,resourceLoader:loader,diagnostics:[]},diagnostics:[]}
  }
  const manager=SessionManager.inMemory(dir),initial=await build(manager)
  const session=initial.session
  const owner=new AgentSessionRuntime(session,initial.services,opts=>build(opts.sessionManager,opts.sessionStartEvent))
  let main=0,background=0,stage=0,holdMain,mainRelease
  const observed=[];session.subscribe(event=>observed.push(event))
  const response=async(context,options)=>{
    const serialized=JSON.stringify(context)
    if(serialized.includes('Extract at most one confirmed')){
      background++
      if(mode==='failure')throw Error('synthetic provider failed')
      const facts=['write','update','cancel','switch','reload'].includes(mode)?[{text:fact,title:fact,status:'confirmed',sources:[{index:0,quote:fact}]}]:[]
      return fauxAssistantMessage(JSON.stringify({facts}))
    }
    if(serialized.includes('isolated memory worker')){
      background++
      const steps=[[fauxToolCall('respire_memory',{command:'prompt'}),fauxToolCall('respire_memory',{command:'recall',text:'release'})],
        [fauxToolCall('respire_memory',{command:'show',id:parent})],
        [fauxToolCall('respire_memory',{command:mode==='update'?'update':'remember',text:fact,title:fact,...(mode==='update'?{id:parent}:{parent})})]]
      return fauxAssistantMessage(steps[stage++],{stopReason:'toolUse'})
    }
    main++
    if(mode==='main-error')return fauxAssistantMessage('',{stopReason:'error',errorMessage:'synthetic main failure'})
    if(mode==='main-abort')await new Promise((_,reject)=>{holdMain=true;options.signal.addEventListener('abort',()=>reject(Error('synthetic cancellation')),{once:true})})
    if(mode==='queue'&&main===1)await new Promise(resolve=>{mainRelease=resolve;holdMain=true})
    return fauxAssistantMessage('Normal user answer.')
  }
  faux.setResponses(Array.from({length:30},()=>response))
  return {session,owner,state,manager,observed,main:()=>main,background:()=>background,held:()=>holdMain,release:()=>mainRelease(),cleanup:async()=>{await owner.session.abort();await owner.session.extensionRunner.emit({type:'session_shutdown'});owner.session.dispose()}}
}

for(const mode of ['none','write','update','failure','queue','cancel','switch','reload','main-error','main-abort']){
 const h=await fixture(mode)
 try{
  const running=h.session.prompt(fact)
  if(mode==='queue'){
   await until(h.held);await h.session.prompt('Queued follow-up request.',{streamingBehavior:'followUp'});h.release()
  }
  if(mode==='main-abort'){await until(h.held);await h.session.abort()}
  await running
  assert.equal(h.session.isIdle,true,'main session must settle without awaiting worker')
  if(mode==='write'||mode==='update')await until(()=>h.state().calls.filter(c=>c[0]==='show').length===2)
  else if(mode==='failure')await until(()=>h.session.messages.some(m=>m.role==='custom'&&m.customType==='respire-status'))
  else if(['cancel','switch','reload'].includes(mode)){
   await until(()=>h.state().writeStarted)
   if(mode==='switch') {
    await h.owner.newSession()
    assert.notEqual(h.owner.session.sessionManager.getSessionId(),h.manager.getSessionId())
    assert.ok(!h.owner.session.messages.some(m=>m.role==='custom'&&m.customType==='respire-status'),'old warning must never enter new session')
   } else if(mode==='reload')await h.session.reload()
   else await h.session.prompt('/nomem next real input')
   await until(()=>h.session.messages.some(m=>m.role==='custom'&&m.customType==='respire-status'))
   assert.equal(h.state().writes.length,0)
  }else if(!['main-error','main-abort'].includes(mode))await until(()=>h.background()>0)
  if(['main-error','main-abort'].includes(mode))assert.equal(h.background(),0)
  assert.equal(h.session.isIdle,true)
  assert.equal(h.main(),mode==='queue'||mode==='cancel'?2:1,'no wrap-up main-agent continuation')
  const assistant=h.session.messages.filter(m=>m.role==='assistant')
  assert.equal(assistant.length,h.main());if(['main-error','main-abort'].includes(mode))assert.ok(assistant.some(m=>['error','aborted'].includes(m.stopReason)))
  else assert.ok(assistant.every(m=>JSON.stringify(m.content).includes('Normal user answer.')))
  assert.equal(h.observed.filter(e=>e.type==='agent_settled').length,mode==='queue'?1:h.main())
  assert.ok(!h.session.messages.some(m=>m.customType==='respire-context'),'request/worker context must not enter history')
  if(['none','write','update','queue'].includes(mode))assert.ok(!h.session.messages.some(m=>m.role==='custom'),'ordinary worker content must not enter history')
  if(mode==='write'||mode==='update'){assert.deepEqual(h.state().writes,[{content:fact,title:fact}]);assert.equal(h.background(),4)}
  if(mode==='none'||mode==='queue')assert.equal(h.state().writes.length,0)
  count++
 }finally{await h.cleanup()}
}
console.log(`Real AgentSession check: ${count} isolated provider/CLI scenarios green`)
