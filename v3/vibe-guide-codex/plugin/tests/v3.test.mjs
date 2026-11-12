import test from 'node:test';
import assert from 'node:assert/strict';
import { V3Service } from '../dist/v3/service.js';
import { reconcileIssues, deliveryCandidate, ready, transfer } from '../dist/v3/domain.js';
const brief={audience:'顾客',goal:'预约活动',flow:'选择时段并填写联系方式，店主查看名单',scope:'报名与查看名单',acceptance:'提交后店主可看见，不重复占用时段',constraints:'不收款，不公开手机号',openQuestions:'通知方式待定'};
const frame=()=>({sessionId:'s1',projectId:'p1',projectName:'测试项目',enabled:true,seq:10,segmentStart:0,busy:false,waiting:false,modelReady:true,evidence:[],operations:[],partial:false});
const failed=(id,seq=12,key='check-A')=>({id,key,label:'检查报名流程',kind:'check',outcome:'failed',endedAt:new Date(100000).toISOString(),seq,changedFiles:[],applicable:'unknown'});
function fixture(){
 const docs=new Map();const store={async readDocument(k){return structuredClone(docs.get(k));},async writeDocument(k,v){docs.set(k,structuredClone(v));},async deleteDocument(k){docs.delete(k);}};
 let f=frame(),calls=0,source,mode='normal',release,entered;
 const host={async observe(id){return {...structuredClone(f),sessionId:id};},async generate(fr,s,system,signal){calls++;source=s;
  if(mode==='invalid')return 'bad json';
  if(mode==='slow'){entered?.();await new Promise((resolve,reject)=>{release=resolve;signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true});});}
  if(system.includes('需求访谈'))return JSON.stringify({brief,question:'需要发送通知吗？',options:['先不需要（推荐）','需要'],contradictions:[]});
  if(system.includes('解释这个具体问题'))return JSON.stringify({summary:'检查没通过，原因待核对',impact:'尚不能确认可用',nextStep:'重复检查',transfer:'请定位失败原因，保留数据。'});
  if(system.includes('把本次任务过程'))return JSON.stringify({sections:[{title:'成果',text:'Agent 表示已完成，尚未验证。',evidenceRefs:mode==='invented'?['fake']:s.evidence.length?[s.evidence.at(-1).id]:[`op:${s.operations[0].id}`]}],limitations:['没有看到用户试用']});
  return '数据库用于保存记录；当前任务采用什么保存方式，现有证据未确认。';
 }};
 const service=new V3Service(store,host,()=>120000);let count=0;
 async function get(sessionId='s1'){return service.get({sessionId});}
 async function act(action,payload={},opts={}){const v=await get(opts.sessionId);const t=opts.task??v.task;return service.action({sessionId:opts.sessionId??'s1',...(t?{taskId:t.id,expectedRevision:t.revision}:{}),requestId:opts.requestId??`req-${++count}`,action,payload},opts.signal??new AbortController().signal);}
 return {service,docs,store,get,act,setFrame(v){f={...f,...v};},get calls(){return calls;},get source(){return source;},setMode(v){mode=v;},waitForCall(){return new Promise(r=>entered=r);},release(){release?.();}};
}
test('read-only views never call model; create, request replay, scope checks and revision checks',async()=>{
 const x=fixture();assert.equal((await x.get()).task,undefined);assert.equal(x.calls,0);
 const v=await x.act('create',{}, {requestId:'create-once'});assert.equal(v.task.startSeq,10);
 await x.act('create',{}, {requestId:'create-once'});assert.equal((await x.get()).tasks.length,1);
 await x.act('settings',{autoDiagnosis:false,autoRecap:false});
 await assert.rejects(x.service.action({sessionId:'s1',taskId:v.task.id,expectedRevision:0,requestId:'stale',action:'confirm',payload:{}},new AbortController().signal),/更新/);
 await assert.rejects(x.act('confirm',{}, {sessionId:'other',task:v.task}),/不属于/);
 assert.equal(x.calls,0);
});
test('interview preserves exact input, produces unconfirmed brief and idempotent response',async()=>{
 const x=fixture();await x.act('create');const t=(await x.get()).task;
 const request={sessionId:'s1',taskId:t.id,expectedRevision:t.revision,requestId:'answer-one',action:'answer',payload:{text:'不收款、不公开手机号，做预约。'}};
 const a=await x.service.action(request,new AbortController().signal);assert.equal(a.task.confirmed,false);assert.equal(a.task.turns[0].answer,request.payload.text);assert.match(a.task.transfer,/不公开手机号/);
 await x.service.action(request,new AbortController().signal);assert.equal(x.calls,1);
 await assert.rejects(x.service.action({...request,payload:{text:'换个需求'}},new AbortController().signal),/不能更改/);
 await x.act('confirm');assert.equal((await x.get()).task.confirmed,true);
 await x.act('revise',{brief:{...brief,goal:'预约会议室'}});assert.equal((await x.get()).task.confirmed,false);
});
test('provider failure retains interview input and does not manufacture readiness',async()=>{
 const x=fixture();await x.act('create');x.setMode('invalid');await assert.rejects(x.act('answer',{text:'我要做预约'}),/完整结构/);
 const t=(await x.get()).task;assert.equal(t.turns.length,1);assert.equal(t.confirmed,false);assert.equal(t.brief.goal,'');
 assert.equal(ready(t.brief,t.contradictions),false);
});
test('no-directory drafts bind explicitly and project switches cannot merge tasks',async()=>{
 const x=fixture();x.setFrame({projectId:undefined});await x.act('create');await x.act('revise',{brief});
 x.setFrame({projectId:'p1',segmentStart:20,seq:22});assert.equal((await x.get()).needsBinding,true);
 await x.act('bind');assert.equal((await x.get()).task.startSeq,22);
 const t=(await x.get()).task;x.setFrame({projectId:'p2',segmentStart:40,seq:40});assert.equal((await x.get()).task,undefined);
 await assert.rejects(x.act('ask',{text:'解释'},{task:t}),/项目或历史/);
});
test('self recovery, repeated failure grouping, unrelated success and active repair grace',()=>{
 const f=frame();f.operations=[failed('a')];assert.equal(reconcileIssues([],f,105000).length,0);
 let issues=reconcileIssues([],f,120000);assert.equal(issues.length,1);
 f.operations.push(failed('b',13));issues=reconcileIssues(issues,f,120000);assert.equal(issues.length,1);assert.equal(issues[0].count,2);
 f.operations.push({...failed('other',14,'check-B'),outcome:'succeeded'});assert.equal(reconcileIssues(issues,f,120000)[0].state,'open');
 f.operations.push({...failed('pass',15),outcome:'succeeded'});assert.equal(reconcileIssues(issues,f,120000)[0].state,'resolved');
 assert.equal(reconcileIssues([],{...frame(),busy:true,operations:[failed('a')]},120000).length,0);
});
test('background diagnostics run once, obey budget, and refresh is model-free',async()=>{
 const x=fixture();await x.act('create');await x.act('activate',{allowIncomplete:true});x.setFrame({seq:12,operations:[failed('a')]});
 await x.service.tickSession('s1');assert.equal(x.calls,1);assert.equal((await x.get()).task.usage.diagnosis,1);
 await x.service.tickSession('s1');await x.get();assert.equal(x.calls,1);
 x.setFrame({seq:13,operations:[failed('a'),{...failed('pass',13),outcome:'succeeded'}]});
 assert.equal((await x.get()).task.issues[0].state,'resolved');
});
test('side conversations are independent and bounded to task start; forged selection rejected',async()=>{
 const x=fixture();await x.act('create');x.setFrame({seq:12,evidence:[{id:'old',seq:9,kind:'user',text:'旧任务秘密'},{id:'new',seq:12,kind:'assistant',text:'使用数据库保存记录'}]});
 const v=await x.act('ask',{text:'这是什么',selection:'数据库',selectionRef:'new',threadId:'side-1'});assert.equal(v.task.answers.length,1);assert.equal(x.source.evidence.length,1);assert.equal(x.source.evidence[0].id,'new');
 await assert.rejects(x.act('ask',{text:'解释',selection:'伪造文本',selectionRef:'new'}),/来源无法核对/);
 await x.act('clearAnswers');assert.equal((await x.get()).task.answers.length,0);
});
test('recap uses validated sources, caches same basis and never marks task closed',async()=>{
 const x=fixture();await x.act('create');x.setFrame({seq:12,evidence:[{id:'event:12',seq:12,kind:'assistant',text:'已完成页面'}]});
 await x.act('recap');const a=await x.get();assert.equal(a.task.recaps.length,1);assert.match(a.task.recaps[0].verification,/没有取得/);assert.notEqual(a.task.state,'closed');
 await x.act('recap');assert.equal(x.calls,1);
 x.setFrame({seq:13,evidence:[{id:'event:13',seq:13,kind:'assistant',text:'再改一点'}]});x.setMode('invented');await assert.rejects(x.act('recap'),/无法核对的来源/);assert.equal((await x.get()).task.recaps.length,1);
});
test('automatic recap candidate requires explicit delivery, not ordinary quiet',()=>{
 const f=frame();f.evidence=[{id:'e',seq:12,kind:'assistant',text:'我先看看'}];assert.equal(deliveryCandidate(f),false);
 f.evidence[0].text='已完成页面，可以试用';assert.equal(deliveryCandidate(f),true);assert.equal(deliveryCandidate({...f,busy:true}),false);assert.equal(deliveryCandidate({...f,waiting:true}),false);
 f.evidence[0].text='尚未完成';assert.equal(deliveryCandidate(f),false);
});
test('deletion cancels in-flight model and never resurrects a task',async()=>{
 const x=fixture();await x.act('create');x.setMode('slow');const entered=x.waitForCall();
 const pending=x.act('ask',{text:'数据库是什么'});const rejected=assert.rejects(pending,/aborted/);await entered;
 const t=(await x.get()).task;await x.act('delete',{}, {task:t});await rejected;assert.equal((await x.get()).tasks.length,0);
});
test('restarts restore tasks without sending or generation',async()=>{
 const x=fixture();await x.act('create');await x.act('revise',{brief});const y=new V3Service(x.store,{observe:async()=>frame(),generate:async()=>{throw new Error('must not call');}});
 await y.start();assert.equal((await y.get({sessionId:'s1'})).task.brief.goal,brief.goal);await y.stop();
});
test('handoff exposes unresolved decisions instead of inventing a stack',()=>{
 const s=transfer({...brief,acceptance:''});assert.match(s,/尚未明确/);assert.match(s,/不公开手机号/);assert.doesNotMatch(s,/React|PostgreSQL/);
});

test('automatic recap persists its budget, never repeats unchanged evidence, and respects opt-out',async()=>{
 const x=fixture();await x.act('create');await x.act('activate',{allowIncomplete:true});
 x.setFrame({seq:12,evidence:[{id:'e12',seq:12,kind:'assistant',text:'已完成页面，可以试用'}]});
 await x.service.tickSession('s1');assert.equal((await x.get()).task.recaps.length,1);assert.equal((await x.get()).task.state,'review');assert.equal((await x.get()).task.usage.recap,1);
 await x.service.tickSession('s1');assert.equal(x.calls,1);
 await x.act('settings',{autoDiagnosis:false,autoRecap:false});x.setFrame({seq:13,evidence:[{id:'e13',seq:13,kind:'assistant',text:'已完成下一阶段'}]});await x.service.tickSession('s1');assert.equal(x.calls,1);
});

test('model request context stays valid, bounded and explicitly marks truncation',async()=>{
 const {boundedContext}=await import('../dist/v3/context.js');
 const value={question:'解释',evidence:Array.from({length:60},(_,i)=>({id:`e${i}`,text:'长'.repeat(4000)}))};
 const b=boundedContext(value);assert.ok(b.truncated);assert.ok(JSON.stringify(b.value).length<54000);assert.equal(b.value.question,'解释');assert.ok(b.value.evidence.some(e=>e.id==='e59'));
});

test('historical tasks never absorb later tasks in the same session',async()=>{
 const x=fixture();await x.act('create');const first=(await x.get()).task;
 x.setFrame({seq:12,evidence:[{id:'e12',seq:12,kind:'assistant',text:'任务一的实施'}]});
 await x.act('create');const firstMeta=(await x.get()).tasks.find(t=>t.id===first.id);
 x.setFrame({seq:20,evidence:[{id:'e12',seq:12,kind:'assistant',text:'任务一的实施'},{id:'e20',seq:20,kind:'assistant',text:'任务二的私有内容'}]});
 await x.act('select',{}, {task:{...first,revision:firstMeta.revision}});const v=await x.get();
 assert.equal(v.frame.seq,12);assert.deepEqual(v.frame.evidence.map(e=>e.id),['e12']);
 await assert.rejects(x.act('activate',{allowIncomplete:true}),/封存/);
});

test('a new diagnosis refreshes reported issue basis and makes its current instruction usable',async()=>{
 const x=fixture();await x.act('create');await x.act('report',{text:'预期能保存，实际刷新后没有了'});
 x.setFrame({seq:12,evidence:[{id:'e12',seq:12,kind:'assistant',text:'目前使用本机存储'}]});assert.equal((await x.get()).task.issues[0].stale,true);
 const id=(await x.get()).task.issues[0].id;await x.act('diagnose',{issueId:id});assert.equal((await x.get()).task.issues[0].stale,false);
});
