import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, mkdir, rm, writeFile, readFile, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { DEFAULT_APP, desktopExecutable, desktopHost, prepareDesktopPlugin, sourceRoot } from './desktop.mjs';

const { values } = parseArgs({ options: { installed: { type: 'string' }, serve: { type: 'boolean' } } });
const installedDirectory = values.installed ? resolve(values.installed) : undefined;
if (!process.versions.electron) {
  const result = spawnSync(desktopExecutable(), [
    '--expose-internals', fileURLToPath(import.meta.url), ...process.argv.slice(2),
  ], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'inherit' });
  if (result.error) console.error(result.error.message);
  process.exitCode = result.status ?? 1;
} else {
  const originalSignalListeners = new Map(['SIGINT', 'SIGTERM'].map(name => [name, new Set(process.rawListeners(name))]));
  const host = await desktopHost();
  const temporary = await mkdtemp(join(tmpdir(), 'vibeguide-guide-smoke-'));
  const projectDirectory = join(temporary, 'project');
  await mkdir(projectDirectory);
  const previousHome = process.env.DSH_HOME;
  const previousCwd = process.cwd();
  process.env.DSH_HOME = temporary; process.chdir(temporary);
  const web = await host.load('@deepseek-ai/dsh-web-app');
  const originalOpener = web.internals.openBrowser;
  web.internals.openBrowser = async () => { throw new Error('No browser opening in host smoke test'); };
  let root;
  let installedPresetBefore;
  try {
    const profileDirectory = join(temporary, 'profiles', 'desktop');
    await mkdir(profileDirectory, { recursive: true });
    await writeFile(join(profileDirectory, 'package.json'), JSON.stringify({ name: 'vibeguide-guide-smoke', private: true,
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } }));
    const originalRows = [
      { id: 'hmr', disabled: true },
      { id: 'session-telemetry-otel', config: { mode: 'DISABLED' } },
      { id: 'session-title-llm', disabled: true },
      { id: 'desktop-product-telemetry', disabled: true },
      { id: 'product-analytics', disabled: true },
      { id: 'web-runtime', config: { printUrl: false, openBrowser: false } },
    ];
    const patchPath = join(profileDirectory, 'cordis.patch.yml');
    let pluginDirectory;
    if (installedDirectory) {
      // Cordis persists fiber.dispose() as disabled in the owning include. Never
      // give the smoke test's Loader ownership of a daily installation's file.
      installedPresetBefore = await readFile(join(installedDirectory, 'preset.cordis.yml'), 'utf8');
      pluginDirectory = join(temporary, 'installed-copy');
      await cp(installedDirectory, pluginDirectory, { recursive: true });
      const sourcePrefix = pathToFileURL(installedDirectory + '/').href;
      const targetPrefix = pathToFileURL(pluginDirectory + '/').href;
      const rebase = value => typeof value === 'string'
        ? value.startsWith(sourcePrefix) ? targetPrefix + value.slice(sourcePrefix.length) : value
        : Array.isArray(value) ? value.map(rebase)
        : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, field]) =>
          [key, key === 'storageRoot' ? join(temporary, 'isolated-state') : rebase(field)])) : value;
      await writeFile(join(pluginDirectory, 'preset.cordis.yml'), host.dump(rebase(host.parse(installedPresetBefore))));
      await writeFile(patchPath, host.dump([...originalRows, { insert: [{
        id: 'vibeguide-presets', name: 'cordis:include', config: { path: join(pluginDirectory, 'preset.cordis.yml') },
      }] }]));
    } else {
      // Exercise the actual CLI upgrade, including custom legacy storage and backups.
      const storageRoot = join(temporary, 'existing-records');
      await mkdir(storageRoot);
      const recordFile = join(storageRoot, 'retained.json');
      await writeFile(recordFile, '{"retained":true}\n');
      const legacy = await prepareDesktopPlugin(host, join(temporary, 'legacy-plugin'), { storageRoot });
      let before = host.dump([...originalRows, legacy.patch]);
      await writeFile(patchPath, before);
      for (let pass = 0; pass < 2; pass++) {
        const install = spawnSync(process.execPath, [
          '--expose-internals', fileURLToPath(new URL('./install-desktop.mjs', import.meta.url)),
          '--home', temporary, '--upgrade',
        ], { env: process.env, encoding: 'utf8', timeout: 30000 });
        assert.equal(install.status, 0, install.stderr);
        const result = JSON.parse(install.stdout);
        assert.equal(result.edition, 'sidebar');
        assert.equal(result.storageRoot, storageRoot, 'legacy storage location must survive repeated sidebar upgrades');
        assert.equal(await readFile(result.backup, 'utf8'), before);
        assert.equal(await readFile(recordFile, 'utf8'), '{"retained":true}\n');
        before = await readFile(patchPath, 'utf8');
        const rows = host.parse(before);
        assert.deepEqual(rows.slice(0, -1), originalRows, 'unrelated settings must survive');
        assert.equal(rows.flatMap(row => row.insert ?? []).filter(row => row.id === 'vibeguide-presets').length, 1);
        pluginDirectory = result.packageDirectory;
      }
    }
    const manifest = JSON.parse(await readFile(join(pluginDirectory, 'package.json'), 'utf8'));
    assert.equal(manifest.dsh.client.immediately, true);
    assert.equal(manifest.exports['.'], './dist/guide/plugin.js');
    assert.ok((await readFile(join(pluginDirectory, 'dist', 'client.js'), 'utf8')).includes('__ModuleLoader__'));
    const declaration = host.parse(await readFile(join(pluginDirectory, 'preset.cordis.yml'), 'utf8'));
    assert.equal(declaration.filter(row => row.id === 'vibeguide-guide').length, 1);
    assert.equal(declaration.filter(row => row.config?.id === 'vibeguide').length, 1);
    const { loadProfileDirectory, loadLayeredEnv } = await host.load('@deepseek-ai/dsh-app-boot');
    const { runProfile } = await host.load('@deepseek-ai/dsh/profile-boot');
    const profile = loadProfileDirectory('vibeguide-guide-smoke', profileDirectory, host.anchor);
    const app = await runProfile({ environment: loadLayeredEnv('vibeguide-guide-smoke'), profile: 'desktop',
      resolvedProfile: { profile, installAnchor: host.anchor }, patchFiles: [], args: ['--no-open', '--host', '127.0.0.1', '--port', '0'] });
    root = app.ctx;
    assert.ok(root.clientModules.graph().entries.some(entry => entry.id === 'vibeguide'),
      'VibeGuide client must be present in the boot graph before Desktop captures its injections');
    // This isolated harness owns shutdown. Let our finally block complete instead of
    // the CLI's process-exit signal handler racing temporary-profile cleanup.
    for (const [name, original] of originalSignalListeners) {
      for (const listener of process.rawListeners(name)) if (!original.has(listener)) process.removeListener(name, listener);
    }
    assert.ok(root.vibeGuide, 'host service must be mounted once');
    await assert.rejects(root.vibeGuide.v3View({ sessionId: 'untrusted' }, new AbortController().signal), { code: 'vibeguide/access-denied' });
    assert.equal(typeof root.vibeGuide.handoff, 'undefined', 'legacy sending RPC must not be mounted');
    let modelCalls = 0, mainPhase = 0;
    root.llm.registerAdapter(['vibeguide-v3-fixture'], {
      providerInfo: provider => ({ id: provider, name: 'VibeGuide v3 deterministic fixture' }),
      providerRetryPolicy: () => undefined,
      listModels: async provider => [{ provider, id: 'fixture', name: 'Fixture (no network)' }],
      resolveModel: async (provider, model) => ({ provider, id: model, name: 'Fixture' }),
      prepareCall: async (provider, model) => ({ model: { provider, id: model, name: 'Fixture' }, async *stream(options) {
        if (typeof options.system==='string' && options.system.includes('你是 VibeGuide，服务完全不懂代码')) {
          modelCalls++; assert.equal(options.tools?.length ?? 0, 0);
          const source = JSON.parse(options.messages.at(-1).content.find(p => p.type === 'text').text);
          let result = '部署就是把网页放到别人可以通过网址访问的地方。当前记录还不能证明已经上线。';
          if(options.system.includes('需求访谈')) result = JSON.stringify({ brief: {audience:'顾客与店主',goal:'做一个预约报名工具',flow:'顾客选择时段填写信息，店主查看名单',scope:'预约和名单',acceptance:'预约后能看到对应记录，同一时段不重复占用',constraints:'不收款，不公开手机号',openQuestions:'是否需要通知'}, question:'提交预约后需要通知店主吗？', options:['先不需要（推荐）','需要'], contradictions:[] });
          if(options.system.includes('解释这个具体问题')) result = JSON.stringify({summary:'报名流程检查没有通过，原因待核对。',impact:'目前不能确认报名功能可用。',nextStep:'定位失败并重跑相同检查。',transfer:'请核对报名流程检查的实际失败原因，做最小修复并重新检查，保留数据和不公开手机号的限制。'});
          if(options.system.includes('把本次任务过程')) result = JSON.stringify({sections:[{title:'本阶段过程',text:'主 Agent 执行了检查，但有失败结果。交付陈述尚未等于用户验收。',evidenceRefs:[source.evidence.at(-1)?.id ?? `op:${source.operations[0].id}`]}],limitations:['尚未取得完整功能验收，也未确认上线。']});
          yield {type:'text-delta', index:0,text:result};yield {type:'finish',reason:{kind:'stop'}};return;
        }
        if(mainPhase < 2){
          const check={command:'node --test verify.test.mjs',description:'检查预约报名流程'};
          if(options.tools?.some(t=>t.name==='bash'))yield {type:'tool-call-delta',index:0,id:`main-check-${mainPhase++}`,name:'bash',argumentsDelta:JSON.stringify(check)};
          else {mainPhase=2;yield {type:'tool-call-delta',index:0,id:'main-checks',name:'run_code',argumentsDelta:JSON.stringify({code:`await tools.bash(${JSON.stringify(check)}); await tools.bash(${JSON.stringify(check)});`,description:'重复核对预约报名流程'})};}
          yield {type:'finish',reason:{kind:'tool-calls'}};return;
        }
        yield {type:'text-delta',index:0,text:'本阶段完成，可以试用页面。检查有失败，需要进一步处理。部署尚未确认。'};
        yield {type:'finish',reason:{kind:'stop'}};
      } }),
    });
    const workspace = await root.workspaceRegistry.create(projectDirectory, 'VibeGuide v3 隔离验证');
    const {sessionId} = await root.sessionController.create({workspaceId:workspace.id,agentPreset:'vibeguide'});
    await root.sessionController.selectModel({sessionId,provider:'vibeguide-v3-fixture',model:'fixture'});
    const peer={id:'v3-owner',principal:{kind:'owner'},signal:new AbortController().signal};
    const invoke=(method,request,identity=peer)=>root.typertGateway.invoke({namespace:'vibeGuide',method,args:{request},signal:new AbortController().signal,peer:identity});
    const view=()=>invoke('v3View',{sessionId});let req=0;
    const act=async(action,payload={})=>{for(let retry=0;retry<4;retry++){const v=await view();try{return await invoke('v3Action',{sessionId,...(v.task?{taskId:v.task.id,expectedRevision:v.task.revision}:{}),requestId:`smoke-${++req}`,action,payload});}catch(e){if(e.code!=='vibeguide/revision_changed'||retry===3)throw e;}}};
    await assert.rejects(invoke('v3View',{sessionId},{...peer,principal:{kind:'guest'}}));
    assert.equal((await view()).task,undefined);assert.equal(modelCalls,0);
    await act('create');const before=(await root.sessionQuery.observeSession(sessionId,{projectionMode:'all'}));const beforeSeq=before.cursor;before[Symbol.dispose]();
    await act('answer',{text:'我要做预约报名工具，顾客预约、店主查看名单，不收款，不公开手机号。'});
    assert.equal((await view()).task.confirmed,false);assert.match((await view()).task.transfer,/不公开手机号/);
    await act('confirm');await act('activate');await act('settings',{autoDiagnosis:true,autoRecap:false});
    await act('ask',{text:'部署是什么意思？',selection:'部署',threadId:'fixture-thread'});
    const after=await root.sessionQuery.observeSession(sessionId,{projectionMode:'all'});assert.equal(after.cursor,beforeSeq,'plugin questions and interview do not write main history');after[Symbol.dispose]();
    const reads=modelCalls;await view();await view();assert.equal(modelCalls,reads);
    await writeFile(join(projectDirectory,'verify.test.mjs'),'import assert from "node:assert/strict";assert.equal(1,2);');
    await root.sessionController.prompt({sessionId,requestId:'fixture-main-native',content:[{type:'text',text:'请检查预约报名流程，不要删除数据。'}]},new AbortController().signal);
    let latest;
    for(let n=0;n<160;n++){latest=await view();if(latest.frame.operations.filter(o=>o.outcome==='failed').length>=2&&!latest.frame.busy)break;await new Promise(r=>setTimeout(r,100));}
    if(latest.frame.operations.filter(o=>o.outcome==='failed').length<2){const cut=await root.sessionQuery.observeSession(sessionId,{projectionMode:'all'}); console.log(JSON.stringify({frame:latest.frame,events:cut.events.filter(e=>['assistant/attempt','step/end','turn/end','tool/call'].includes(e.type)).map(e=>({type:e.type,seq:e.seq,data:e.data}))}));cut[Symbol.dispose]();}
    assert.ok(latest.frame.operations.filter(o=>o.outcome==='failed').length>=2,JSON.stringify(latest.frame.operations));
    for(let n=0;n<100;n++){latest=await view();if(latest.task.issues.some(i=>i.state==='open'&&i.diagnosisBasis))break;await new Promise(r=>setTimeout(r,200));}
    assert.ok(latest.task.issues.some(i=>i.count>=2&&i.diagnosisBasis),'native repeated failures produce one automatically explained issue');
    await act('recap');latest=await view();assert.equal(latest.task.recaps.length,1);assert.notEqual(latest.task.state,'closed');
    const total=modelCalls;await act('recap');assert.equal(modelCalls,total,'same recap basis is cached');
    await act('settings',{autoDiagnosis:false,autoRecap:false});
    console.log(JSON.stringify({hostVersion:host.version,desktopApp:DEFAULT_APP,realHostMounted:true,ownerAuthorization:true,interview:true,selectionSideQuestion:true,mainHistoryUnchanged:true,nativeToolFailures:true,automaticDiagnosis:true,recapSources:true,noSendingRPC:true,realProviderCalled:false,userProfileModified:false,modelCalls}));
    if(values.serve){
      const readyFile=join(sourceRoot,'output','playwright','guide-ready.json');await mkdir(join(sourceRoot,'output','playwright'),{recursive:true});
      await writeFile(readyFile,JSON.stringify({url:root.connection.authenticatedUrl(`${root.webServer.protocol}//127.0.0.1:${root.webServer.port}`),sessionId,pid:process.pid}),{mode:0o600});
      console.log('Isolated V3 UI is ready.');
      await new Promise(resolve=>{process.once('SIGTERM',resolve);process.once('SIGINT',resolve);});await rm(readyFile,{force:true});
    }
    const entry=[...root.loader.entries()].find(e=>e.options.name.endsWith('/dist/guide/plugin.js'));assert.ok(entry?.fiber);await entry.fiber.dispose();assert.equal(root.vibeGuide,undefined);
    const config=declaration.find(r=>r.id==='vibeguide-guide').config;
    const reloaded=root.plugin(await import(pathToFileURL(join(pluginDirectory,'dist/guide/plugin.js')).href),config);
    for(let n=0;n<100;n++){try{latest=await view();break;}catch{await new Promise(r=>setTimeout(r,50));}}
    assert.equal(latest.task.recaps.length,1);if(!values.serve)assert.equal(modelCalls,total);await reloaded.dispose();
    console.log(JSON.stringify({unload:true,reloadRestoresTask:true,writerGuardReleased:true,noAutomaticResend:true}));
  } finally {
    try { if(root)await root.fiber.dispose(); }
    finally {web.internals.openBrowser=originalOpener;process.chdir(previousCwd);if(previousHome===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=previousHome;await rm(temporary,{recursive:true,force:true});}
  }
}
