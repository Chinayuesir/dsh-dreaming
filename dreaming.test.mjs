import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm, writeFile, mkdir, symlink } from 'node:fs/promises';
import { Script } from 'node:vm';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { executeDream, published, versions } from './workflow/runtime.js';
import { pendingDraft, reviewDraft, scopeRoot, createDraft, fingerprint, resolveConflict } from './workflow/review.js';
import { createMemoryUsage } from './workflow/usage.js';
import { memoryCatalogContext } from './workflow/context.js';
import { stageCopy, atomic } from './workflow/runtime.js';
import { parseDateBounds, sessionDateRanges } from './workflow/dates.js';

const source = (await readFile(new URL('./index.js', import.meta.url), 'utf8'))
  .replace("import { defineTool } from '@deepseek-ai/dsh-tools';", 'const defineTool = definition => definition;')
  .replace("import { createUserMessage } from '@deepseek-ai/dsh-llm';", 'const createUserMessage = input => ({...input,role:"user",id:randomUUID()});')
  .replace(/'(\.\/workflow\/[^']+)'/g, (_match, path) => JSON.stringify(new URL(path, import.meta.url).href))
  .replaceAll('import.meta.url', JSON.stringify(import.meta.url))
  + '\nexport { readStore, readNote, writeNote, buildWeb, workflowHelpers, buildReaderTool, latestSlot };';
const { readStore, readNote, writeNote, buildWeb, workflowHelpers, buildReaderTool, latestSlot, apply } =
  await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

async function withDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'dreaming-test-'));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

const message = (type, text) => type === 'user/message'
  ? {type, data:{content:[{type:'text',text}]}}
  : {type, data:{message:{content:[{type:'text',text}]}}};
const completed = [{type:'turn/end',data:{reason:{kind:'completed'}}}];
const eventList = text => [message('user/message', text), {type:'turn/start'}, message('assistant/message', 'Outcome'), ...completed];
const output = value => [{type:'text-delta', text:JSON.stringify(value)}, {type:'finish', reason:{kind:'stop'}}];
function calls(tool, args) {
  return [...args.map((input, index) => ({
    type:'block-end', index, block:{type:'tool-call', id:'call-' + index, name:tool, arguments:JSON.stringify(input)},
  })), {type:'finish', reason:{kind:'tool-calls'}}];
}

function harness({ broken = false, skipOrganizer = false, analyzerReply = output, organizerReply = output } = {}) {
  const sessions = {
    root: eventList('FIRST page ' + 'a'.repeat(25000) + ' LAST page'),
    child: eventList('Child evidence with api_key=sk-abcdabcdabcdabcdabcd'),
    busy: [message('user/message','Still running'), {type:'turn/start'}],
  };
  const roles = [];
  const ctx = {
    agentDefaultModel: {currentSelection: () => ({provider:'test',model:'fixture'})},
    sessionQuery: {
      listSessions: async () => [
        {header:{id:'root'}},
        {header:{id:'child',parentSession:'root',delegationDepth:1}},
        {header:{id:'busy'}},
      ],
      readSession: async id => ({events:sessions[id]}),
      readSurface: async () => assert.fail('Dreaming needs the raw log, including compacted events'),
    },
    llm: { async *stream({system,messages,tools}) {
      const task = JSON.parse(messages[0].content[0].text);
      if (system.includes('lead of a dreaming run')) {
        assert.deepEqual(task.transcripts.map(input=>input.id), ['root']);
        assert.ok(!JSON.stringify(task).includes('FIRST page'));
        roles.push('lead');
        yield* output({batches:[['root']]});
      } else if (system.includes('maintain a wiki memory store')) {
        assert.ok(!JSON.stringify(task).includes('FIRST page'));
        const results = messages.filter(message=>message.role==='tool').map(message=>JSON.parse(message.content[0].text));
        if (!results.length) {
          roles.push('analyzer');
          yield* calls('read_transcript', [{offset:0}]);
        } else if (results.at(-1).nextOffset !== null && !broken) {
          yield* calls('read_transcript', [{offset:results.at(-1).nextOffset}]);
        } else {
          if (!broken) {
            const full = results.map(page=>page.text).join('');
            assert.match(full, /FIRST page.*LAST page/s);
            assert.match(full, /Child evidence/);
            assert.doesNotMatch(full, /abcdabcdabcd/);
          }
          yield* analyzerReply({summary:'Analyzed', notes:[{
            slug:'topic',title:'Topic',summary:'Verified evidence',
            facts:[{date:'2026-11-09',text:'Exact outcome (root event 3)'}],links:[],
          }]}, messages);
        }
      } else {
        const results = messages.filter(message=>message.role==='tool');
        if (!results.length) {
          roles.push('organizer');
          if (!skipOrganizer) { yield* calls('read_memory', [{slug:'topic',offset:0},{slug:'old',offset:0}]); return; }
        }
        yield* organizerReply({merges:[{from:'old',into:'topic'}],links:{},groups:{topic:'Projects'},changes:[]}, tools);
      }
    } },
  };
  return {ctx,roles};
}

test('scoped workers read full inputs, merge without losing prose, publish and skip unchanged sessions', () => withDir(async dir => {
  await mkdir(join(dir,'notes'));
  await writeFile(join(dir,'notes','old.md'), '# Old topic\n\nHand edited paragraph.\n\n## Facts\n- Old provenance\n');
  const {ctx, roles} = harness();
  const report = await executeDream(ctx, dir, {}, workflowHelpers);
  assert.equal(report.status,'review');
  assert.equal((await readStore(dir)).notes.some(n=>n.slug==='topic'),false);
  const approval = await reviewDraft(dir,{id:report.draftId,action:'publish',confirm:true},workflowHelpers);
  report.version = approval.version;
  assert.deepEqual(roles,['lead','analyzer','organizer']);
  const store = await readStore(dir);
  assert.equal(store.count,1);
  assert.match(store.indexMd, /Projects[\s\S]*\[\[topic\]\]/);
  const content = (await readNote(dir,'topic')).content;
  assert.match(content,/Exact outcome/);
  assert.match(content,/Hand edited paragraph/);
  assert.match(content,/Old provenance/);
  const reader = buildReaderTool({memoryDir:dir});
  const index = JSON.parse(await reader.execute({slug:'_index'}, {signal:new AbortController().signal}));
  assert.equal(index.version, report.version);
  assert.match(index.text, /\[\[topic\]\]/);
  const history = await versions(dir);
  const baseline = history.find(version=>version.kind==='baseline');
  assert.match((await readNote(dir,'old',baseline.version)).content,/Old provenance/);
  assert.equal((await executeDream(ctx, dir, {}, workflowHelpers)).status,'empty');
  assert.equal(roles.length,3);
}));

test('incomplete transcript or organizer reads leave the active store untouched', () => withDir(async dir => {
  await mkdir(join(dir,'notes'));
  await writeFile(join(dir,'notes','old.md'), '# Old topic\n\nOriginal text\n');
  const result = await executeDream(harness({broken:true}).ctx, dir, {}, workflowHelpers);
  assert.equal(result.status,'failed');
  assert.match(result.failures[0].reason,/未读完整/);
  await assert.rejects(executeDream(harness({skipOrganizer:true}).ctx, dir, {}, workflowHelpers), /未读完整记忆库/);
  assert.equal(await published(dir),dir);
  assert.equal((await readStore(dir)).count,1);
  assert.deepEqual(await versions(dir),[]);
}));

test('single-session analysis corrects malformed JSON once and publishes a fenced result', () => withDir(async dir => {
  await mkdir(join(dir,'notes'));
  await writeFile(join(dir,'notes','old.md'), '# Old topic\n');
  let replies = 0;
  const {ctx} = harness({analyzerReply(result, messages) {
    const pages = messages.filter(message => message.toolName === 'read_transcript');
    assert.equal(pages.length, 2);
    if (++replies === 1) return [
      {type:'text-delta', text:'{"summary":"Analyzed","notes":[}'},
      {type:'finish', reason:{kind:'stop'}},
    ];
    assert.match(messages.at(-1).content[0].text, /could not be accepted/);
    const text = '分析完成，结果如下：\n```json\n' + JSON.stringify(result) + '\n```\n整理完毕。';
    return [
      {type:'text-delta', index:0, text},
      {type:'block-end', index:0, block:{type:'text',text}},
      {type:'finish', reason:{kind:'stop'}},
    ];
  }});
  const events = [];
  const report = await executeDream(ctx, dir, {sessionId:'root'}, workflowHelpers, (phase, message, level) => events.push({phase,message,level}));
  assert.equal(replies, 2);
  assert.ok(events.some(event => event.level === 'warn' && /纠正一次/.test(event.message)));
  assert.doesNotMatch(JSON.stringify(events), /FIRST page|summary.*Analyzed/);
  assert.equal(report.status, 'review');
  await reviewDraft(dir,{id:report.draftId,action:'publish',confirm:true},workflowHelpers);
  assert.match((await readNote(dir,'topic')).content, /Exact outcome/);
}));

test('repeated invalid analyzer results stop without publishing memory', () => withDir(async dir => {
  let replies = 0;
  const {ctx, roles} = harness({analyzerReply() {
    replies++;
    return output([]);
  }});
  const report = await executeDream(ctx, dir, {sessionId:'root'}, workflowHelpers);
  assert.equal(replies, 2);
  assert.equal(report.status, 'failed');
  assert.match(report.failures[0].reason, /模型未能提交有效的 JSON/);
  assert.deepEqual(roles, ['lead','analyzer']);
  assert.deepEqual(await versions(dir), []);
}));

test('desktop single-session run publishes when the organizer submits a structured result', () => withDir(async dir => {
  await mkdir(join(dir,'notes'));
  await writeFile(join(dir,'notes','old.md'), '# Old topic\n\nEarlier decisions.\n');
  const {ctx, roles} = harness({organizerReply(result, tools) {
    const prose = {type:'text-delta', text:'已读完两个主题，建议合并相关内容。'};
    return tools.some(tool => tool.name === 'submit_result')
      ? [prose, ...calls('submit_result', [result])]
      : [prose, {type:'finish', reason:{kind:'stop'}}];
  }});
  ctx.llm.listProviders = () => [{id:'test', name:'Default'}, {id:'other', name:'Other'}];
  ctx.llm.listModels = async () => [{id:'fixture', name:'Fixture'}];
  const stream = ctx.llm.stream;
  const routed = [];
  ctx.llm.stream = options => {
    routed.push({provider:options.provider, model:options.model});
    return stream(options);
  };
  const {request,dispose} = server(ctx,{memoryDir:dir,stateDir:dir});
  try {
    const catalog = (await request('/dreaming/api/model?catalog=1')).data();
    assert.deepEqual(catalog.groups.map(group => group.id), ['test','other']);
    assert.deepEqual(catalog.effective, {provider:'test',model:'fixture'});
    const chosen = {provider:'other',model:'fixture'};
    assert.equal((await request('/dreaming/api/model',{model:{...chosen,model:'not-listed'}})).status, 400);
    assert.deepEqual((await request('/dreaming/api/model',{model:chosen})).data().configured, chosen);
    assert.equal((await request('/dreaming/api/start',{sessionId:'root'})).status, 202);
    let job;
    for (let attempt = 0; attempt < 100; attempt++) {
      job = (await request('/dreaming/api/job')).data();
      if (job.status !== 'running') break;
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    assert.equal(job.status, 'review', `${job.phase}: ${job.message}`);
    assert.equal(job.phase, 'publishing');
    assert.equal(job.report.inputsProcessed, 1);
    assert.deepEqual(job.model, chosen);
    assert.equal((await request('/dreaming/api/logs', undefined, false)).status, 401);
    const logs = (await request('/dreaming/api/logs?id=' + job.id)).data();
    assert.equal(logs.selected.status, 'review');
    assert.deepEqual(logs.selected.model, chosen);
    assert.deepEqual([...new Set(logs.selected.entries.map(entry => entry.phase))],
      ['system','collecting','planning','analyzing','organizing','publishing']);
    assert.match(JSON.stringify(logs.selected.entries), /等待回复/);
    assert.doesNotMatch(JSON.stringify(logs), /FIRST page|Child evidence|Exact outcome|sk-abcd/);
    assert.ok(routed.length > 0);
    for (const selection of routed) assert.deepEqual(selection, chosen);
    assert.equal((await readStore(dir)).notes.some(n=>n.slug==='topic'),false);
    const approved = await request('/dreaming/api/review',{id:job.report.draftId,action:'publish',confirm:true});
    assert.equal(approved.status,200);
    assert.deepEqual((await versions(dir)).find(version => version.version === approved.data().version).model, chosen);
    const followDefault = (await request('/dreaming/api/model',{model:null})).data();
    assert.equal(followDefault.configured, null);
    assert.deepEqual(followDefault.effective, {provider:'test',model:'fixture'});
    assert.deepEqual(roles, ['lead','analyzer','organizer']);
    const memory = (await readNote(dir,'topic')).content;
    assert.match(memory, /Exact outcome/);
    assert.match(memory, /Earlier decisions/);

    const query = 'name=topic&version=' + encodeURIComponent(approved.data().version);
    const topic = (await request('/dreaming/api/note?' + query + '&view=map')).data();
    assert.deepEqual(topic.sources.map(source => source.id), ['root']);
    const source = '/dreaming/api/map-source?' + query + '&id=root';
    assert.equal((await request(source,undefined,false)).status, 401);
    assert.equal((await request('/dreaming/api/map-source?' + query + '&id=busy')).status, 404);
    const first = (await request(source)).data();
    assert.match(first.text, /FIRST page/);
    assert.doesNotMatch(first.text, /LAST page/);
    assert.equal(first.nextOffset, first.text.length);
    const last = (await request(source + '&offset=24000')).data();
    assert.match(last.text, /LAST page/);
    assert.equal(last.nextOffset, null);
  } finally { await dispose(); }
}));

test('manual edits create versions and reject stale saves and symlinks', () => withDir(async dir => {
  await mkdir(join(dir,'notes'));
  await writeFile(join(dir,'notes','topic.md'),'# Original\n');
  await symlink(join(dir,'notes','topic.md'),join(dir,'notes','symlink.md'));
  await assert.rejects(readNote(dir,'symlink'),/symlink/);
  const first = await readNote(dir,'topic');
  const saved = await writeNote(dir,{action:'save',name:'topic',revision:first.revision,content:'# Updated\n'});
  assert.match(await readFile(join(await published(dir),'_index.md'),'utf8'),/Updated/);
  await assert.rejects(writeNote(dir,{action:'delete',name:'topic',revision:first.revision,confirm:true}),/changed since/);
  await assert.rejects(readNote(dir,'../topic'),/invalid note name/);
  await writeNote(dir,{action:'delete',name:'topic',revision:saved.revision,confirm:true});
  await assert.rejects(readNote(dir,'topic'),/not found/);
  assert.match((await readNote(dir,'topic',(await versions(dir)).find(version=>version.action==='save').version)).content,/Updated/);
}));

function server(ctx, config) {
  let handle;
  const dispose = buildWeb({
    ...ctx, webServer:{register: route => { handle = route.handler; }},
    connection:{requestRejection: req => req.headers.authorized ? undefined : 401},
  }, config);
  const request = async (url, body, authorized = true) => {
    const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)]);
    Object.assign(req,{url,method:body===undefined?'GET':'POST',headers:{host:'localhost','content-type':'application/json',authorized}});
    let status, text, headers;
    await handle(req,{writeHead(s,h){ status=s;headers=h; },end(value){ text=value; }});
    return {status,headers,text, data:()=>JSON.parse(text)};
  };
  return {request,dispose};
}

test('real routes serve the workbench, protect the store and start a background job', () => withDir(async dir => {
  const {ctx} = harness({broken:true});
  ctx.sessionQuery.readTitleSnapshots = async ids => ids.map(id => ({
    sessionId: id, status: 'fulfilled', value: { title: { title: id === 'root' ? '梦境设计讨论' : '其他会话' } },
  }));
  const {request,dispose} = server(ctx,{memoryDir:dir,stateDir:dir});
  try {
    assert.equal((await request('/dreaming/api/store',undefined,false)).status,401);
    assert.match((await request('/dreaming')).text,/梦境工作台/);
    assert.doesNotThrow(() => new Script((readFileForScript)));
    assert.match((await request('/dreaming/ui/styles.css')).headers['content-type'],/text\/css/);
    assert.equal((await request('/dreaming/api/session-dates')).status, 200);
    assert.equal((await request('/dreaming/api/sessions', undefined, false)).status, 401);
    const catalog = (await request('/dreaming/api/sessions')).data();
    assert.deepEqual(catalog.sessions.map(({id, title}) => ({id, title})), [
      { id:'root', title:'梦境设计讨论' }, { id:'busy', title:'其他会话' },
    ]);
    const invalid = await request('/dreaming/api/start', { since:'2026-11-10', until:'2026-11-09' });
    assert.equal(invalid.status, 400);
    assert.match(invalid.data().error, /起始日期不能晚于结束日期/);
    const result = await request('/dreaming/api/start',{maxSessions:1});
    assert.equal(result.status,202);
    assert.equal((await request('/dreaming/api/start',{maxSessions:1})).status,409);
    let job;
    for (let i=0; i<100; i++) {
      job = (await request('/dreaming/api/job')).data();
      if (job.status !== 'running') break;
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    assert.equal(job.status,'failed');
    assert.match(job.report.failures[0].reason,/未读完整/);
    const log = (await request('/dreaming/api/logs')).data().selected;
    assert.equal(log.status, 'failed');
    assert.ok(log.entries.some(entry => entry.level === 'error' && /未读完整/.test(entry.message)));
  } finally { await dispose(); }
}));

const readFileForScript = await readFile(new URL('./ui/app.js', import.meta.url), 'utf8');
test('presets use local calendar days and the earliest dialogue creation date', () => {
  const records = [
    { header: { id: 'older', createdAt: new Date(2026, 8, 30, 22).toISOString(), updatedAt: new Date(2026, 10, 7).getTime() } },
    { header: { id: 'child', delegationDepth: 1, createdAt: new Date(2026, 7, 1).getTime() } },
  ];
  assert.deepEqual(sessionDateRanges(records, new Date(2026, 10, 11, 14)), {
    all: { since: '2026-09-30', until: '2026-11-11' },
    today: { since: '2026-11-11', until: '2026-11-11' },
    week: { since: '2026-11-09', until: '2026-11-15' },
    month: { since: '2026-11-01', until: '2026-11-30' },
  });
  assert.throws(() => parseDateBounds({ until: '2026-02-30' }), /结束日期无效/);
  assert.equal(parseDateBounds({ until: '2026-11-01' }).end, new Date(2026, 10, 2).getTime() - 1);
});

test('date filters include the complete end day and reject sessions outside the range', () => withDir(async dir => {
  const { ctx } = harness();
  const originalRead = ctx.sessionQuery.readSession;
  const reads = [];
  ctx.sessionQuery.listSessions = async () => [
    { header: { id: 'too-new', updatedAt: new Date(2026, 10, 10).toISOString() } },
    { header: { id: 'root', updatedAt: new Date(2026, 10, 9, 23, 59, 59, 999).getTime() } },
    { header: { id: 'too-old', createdAt: new Date(2026, 10, 9).getTime() - 1 } },
    { header: { id: 'child', parentSession: 'root', delegationDepth: 1 } },
  ];
  ctx.sessionQuery.readSession = async id => {
    reads.push(id);
    return originalRead(id);
  };
  await mkdir(join(dir, 'notes'));
  await writeFile(join(dir, 'notes', 'old.md'), '# Old topic\n');
  const report = await executeDream(ctx, dir, { since: '2026-11-09', until: '2026-11-09' }, workflowHelpers);
  assert.equal(report.status, 'review');
  await reviewDraft(dir,{id:report.draftId,action:'publish',confirm:true},workflowHelpers);
  assert.deepEqual(reads, ['root', 'child']);
}));

test('a selected session bypasses date filters and never falls back to another session', () => withDir(async dir => {
  const { ctx } = harness();
  const originalList = ctx.sessionQuery.listSessions;
  ctx.sessionQuery.listSessions = async () => [{header:{id:'newer'}}, ...await originalList()];
  const originalRead = ctx.sessionQuery.readSession;
  const reads = [];
  ctx.sessionQuery.readSession = async id => {
    reads.push(id);
    return originalRead(id);
  };
  await mkdir(join(dir, 'notes'));
  await writeFile(join(dir, 'notes', 'old.md'), '# Old topic\n');
  await assert.rejects(executeDream(ctx, dir, { sessionId: 'missing' }, workflowHelpers), /找不到/);
  assert.deepEqual(reads, []);
  const report = await executeDream(ctx, dir, {
    sessionId: 'root', since: '2099-01-01', maxSessions: 6,
  }, workflowHelpers);
  assert.equal(report.status, 'review');
  await reviewDraft(dir,{id:report.draftId,action:'publish',confirm:true},workflowHelpers);
  assert.equal(report.inputsProcessed, 1);
  assert.deepEqual(reads, ['root', 'child']);
  await assert.rejects(executeDream(ctx, dir, { sessionId: 'busy' }, workflowHelpers), /尚未正常完成/);
  assert.deepEqual(reads, ['root', 'child', 'busy']);
}));

test('nightly due slot is the latest local time at or before now', () => {
  assert.equal(latestSlot('01:00', new Date(2026, 10, 9, 0, 59)), new Date(2026, 10, 8, 1, 0).toISOString());
  assert.equal(latestSlot('01:00', new Date(2026, 10, 9, 1, 0)), new Date(2026, 10, 9, 1, 0).toISOString());
});

test('conflicts remain private drafts until explicit decisions; approved replacement retains history',()=>withDir(async dir=>{
  const oldFact='使用 A 模型 (root event 1) (2026-11-01)';
  await mkdir(join(dir,'notes'));
  await writeFile(join(dir,'notes','old.md'),'# Old\n');
  await writeFile(join(dir,'notes','topic.md'),`# 模型\nSummary: 使用 A 模型\n\n## Facts\n- ${oldFact}\n`);
  const {ctx}=harness({analyzerReply(result,messages){
    if (!messages.some(m=>m.toolName==='read_memory')) return calls('read_memory',[{slug:'topic',offset:0}]);
    result.notes[0].facts=[{date:'2026-11-15',text:'改用 B 模型 (root event 3)'}];
    result.notes[0].summary='当前使用 B 模型';
    result.conflicts=[{slug:'topic',oldFact,newFact:'改用 B 模型 (root event 3)',reason:'后续会话明确改用 B'}];
    return output(result);
  }});
  const report=await executeDream(ctx,dir,{},workflowHelpers);
  assert.equal(report.status,'review');
  assert.equal(report.version,null);
  const draft=await pendingDraft(dir);
  assert.equal(draft.conflicts.length,1);
  assert.ok(draft.changes.some(c=>c.slug==='topic' && c.kind==='modified'));
  assert.doesNotMatch((await readNote(dir,'topic')).content,/B 模型/);
  await assert.rejects(reviewDraft(dir,{id:draft.id,action:'publish'},workflowHelpers),/明确确认/);
  await assert.rejects(reviewDraft(dir,{id:draft.id,action:'publish',confirm:true},workflowHelpers),/每项冲突/);
  assert.equal((await pendingDraft(dir)).id,draft.id);
  const result=await reviewDraft(dir,{id:draft.id,action:'publish',confirm:true,decisions:{[draft.conflicts[0].id]:'replace'}},workflowHelpers);
  const note=(await readNote(dir,'topic')).content;
  assert.match(note,/\[已被替代\] 使用 A/);
  assert.match(note,/Summary: 当前使用 B/);
  assert.match(note,/替代为：改用 B/);
  assert.equal(await pendingDraft(dir),null);
  assert.equal(result.actualChanges.find(c=>c.slug==='topic').after,note);
  await assert.rejects(reviewDraft(dir,{id:draft.id,action:'publish',confirm:true},workflowHelpers),/草稿已变化/);
  const c=draft.conflicts[0], raw=draft.changes.find(c=>c.slug==='topic').after;
  assert.doesNotMatch(resolveConflict(raw,c,'keep-old'),/改用 B/);
  assert.match(resolveConflict(raw,c,'uncertain'),/\[待核实\] 使用 A/);
}));

test('editing during review rejects stale publication; discard leaves the edited version intact',()=>withDir(async dir=>{
  await mkdir(join(dir,'notes')); await writeFile(join(dir,'notes','old.md'),'# Original\n');
  const report=await executeDream(harness().ctx,dir,{},workflowHelpers);
  const original=await readNote(dir,'old');
  await writeNote(dir,{action:'save',name:'old',revision:original.revision,content:'# Human correction\n'});
  await assert.rejects(reviewDraft(dir,{id:report.draftId,action:'publish',confirm:true},workflowHelpers),/已被编辑/);
  assert.match((await readNote(dir,'old')).content,/Human correction/);
  await reviewDraft(dir,{id:report.draftId,action:'discard'},workflowHelpers);
  assert.equal(await pendingDraft(dir),null);
  assert.match((await readNote(dir,'old')).content,/Human correction/);
}));

test('project readers isolate stores, explicit shared reads work, and tool reads leave bounded metadata',()=>withDir(async dir=>{
  const usage=createMemoryUsage();
  for(const [scope,text] of [['','Shared'],['/work/A','Project A'],['/work/B','Project B']]){
    const root=scopeRoot(dir,scope);await mkdir(join(root,'notes'),{recursive:true});await writeFile(join(root,'notes','topic.md'),`# ${text}\n`);
  }
  const reader=buildReaderTool({memoryDir:dir},undefined,usage);
  const exec={agent:{session:{id:'chat-a',header:{cwd:'/work/A'}}},signal:new AbortController().signal};
  assert.match(JSON.parse(await reader.execute({slug:'topic'},exec)).text,/Project A/);
  assert.match(JSON.parse(await reader.execute({slug:'topic',scope:'shared'},exec)).text,/Shared/);
  assert.equal((await usage.list(dir,'chat-a')).entries.length,2);
  assert.equal((await usage.list(dir,'chat-b')).entries.length,0);
  assert.throws(()=>scopeRoot(dir,'../B'),/完整工作区/);
  const {ctx}=harness();
  await assert.rejects(executeDream(ctx,scopeRoot(dir,'/work/A'),{sessionId:'root',workspace:'/work/A'},workflowHelpers),/不属于当前项目/);
}));

test('conversation binding survives restart as a scoped reference without injecting or logging body',()=>withDir(async dir=>{
  const project=scopeRoot(dir,'/work/A'); await mkdir(join(project,'notes'),{recursive:true});
  await writeFile(join(project,'notes','topic.md'),'# Topic\n\nSensitive private body\n');
  const note=await readNote(project,'topic');await writeNote(project,{action:'save',name:'topic',revision:note.revision,content:note.content});
  const ctx={sessionQuery:{listSessions:async()=>[{header:{id:'a',cwd:'/work/A'}},{header:{id:'b',cwd:'/work/B'}}]}};
  const {request,dispose}=server(ctx,{memoryDir:dir,stateDir:dir});
  try{
    const path='/dreaming/api/use?scope='+encodeURIComponent('/work/A');
    assert.equal((await request(path,{sessionId:'b',slug:'topic'})).status,400);
    assert.equal((await request(path,{sessionId:'a',slug:'topic'})).status,200);
    const restarted=createMemoryUsage();
    assert.equal(restarted.text(dir,'b'),'');
    assert.match(restarted.text(dir,'a','/work/A'),/Topic/);
    assert.doesNotMatch(restarted.text(dir,'a','/work/A'),/Sensitive private body/);
    assert.equal(restarted.text(dir,'a','/work/B'),'');
    restarted.text(dir,'a');
    const record=await restarted.list(dir,'a');
    assert.equal(record.entries.length,0);
    assert.doesNotMatch(JSON.stringify(record.entries),/Sensitive private/);
    await restarted.bind(dir,'a',null);
    assert.equal(restarted.text(dir,'a'),'');
  }finally{await dispose();}
}));

test('new conversations receive only their project and shared catalogs without any history lookup',()=>withDir(async dir=>{
  for(const [scope,label] of [['','共享启动指南'],['/work/A','项目A指南'],['/work/B','其他项目机密']]){
    const root=scopeRoot(dir,scope);await mkdir(join(root,'notes'),{recursive:true});
    await writeFile(join(root,'notes','topic.md'),`# ${label}\n\nSECRET_TOPIC_BODY_SHOULD_REQUIRE_TOOL\n`);
    const note=await readNote(root,'topic');
    await writeNote(root,{action:'save',name:'topic',revision:note.revision,content:note.content});
  }
  let middleware;
  const dispose=apply({tools:{register:()=>()=>{}},on:(event,handler)=>{assert.equal(event,'agent/pre-step');middleware=handler;return()=>{};}},{memoryDir:dir,stateDir:dir});
  try{
    const session={id:'not-in-history',header:{cwd:'/work/A'},seq:0,surface:{nodes:[]},eventAt:()=>undefined};
    const firstTurn={agent:{session},signal:new AbortController().signal};
    const decision=await middleware(firstTurn,async()=>({kind:'enter',messages:[]}));
    assert.equal(decision.messages[0].source.kind,'dreaming-memory');
    assert.equal(decision.messages[0].source.form,'snapshot');
    const text=decision.messages[0].content[0].text;
    assert.match(text,/项目A指南/);assert.match(text,/共享启动指南/);assert.doesNotMatch(text,/其他项目机密/);
    assert.doesNotMatch(text,/SECRET_TOPIC_BODY/);
    assert.match(text,/scope="shared"/);
    assert.match(memoryCatalogContext(dir),/共享启动指南/);
    const rejected={kind:'reject',reason:'fixture'};
    assert.equal(await middleware(firstTurn,async()=>rejected),rejected);
    const abort=new AbortController();abort.abort();
    const untouched={kind:'enter',messages:[]};
    assert.equal(await middleware({...firstTurn,signal:abort.signal},async()=>untouched),untouched);
    // Draft-only topics must not enter the first-turn catalog.
    const root=scopeRoot(dir,'/work/A'),stage=await stageCopy(root),before=await fingerprint(root);
    await writeFile(join(stage,'notes','secret.md'),'# 尚未审核的提议\n');
    await writeFile(join(stage,'_index.md'),'# 尚未审核的提议\n');
    await createDraft(root,stage,{status:'complete'},[],before);
    assert.doesNotMatch(memoryCatalogContext(dir,'/work/A'),/尚未审核/);
  }finally{await dispose();}
}));

test('default memory can be configured with no saved conversations and survives the first new turn',()=>withDir(async dir=>{
  await mkdir(join(dir,'notes'));await writeFile(join(dir,'notes','topic.md'),'# Shared start\n\nFirst-message reference.\n');
  const note=await readNote(dir,'topic');await writeNote(dir,{action:'save',name:'topic',revision:note.revision,content:note.content});
  const ctx={sessionQuery:{listSessions:async()=>{throw Error('history unavailable');}}};
  const {request,dispose}=server(ctx,{memoryDir:dir,stateDir:dir});
  try{
    const response=await request('/dreaming/api/use',{target:'default',slug:'topic'});
    assert.equal(response.status,200,response.text);
    const usage=createMemoryUsage();
    assert.match(usage.text(dir,undefined,'/new/project'),/Shared start/);
    assert.doesNotMatch(usage.text(dir,undefined,'/new/project'),/First-message reference/);
    assert.equal((await usage.list(dir)).entries.length,0,'no fake read record before a session exists');
    assert.match(usage.text(dir,'brand-new','/new/project'),/Shared start/);
    assert.equal((await usage.list(dir,'brand-new')).entries.length,0);
    assert.equal((await request('/dreaming/api/usage')).data().binding.slug,'topic');
    assert.equal((await request('/dreaming/api/use',{target:'default',clear:true})).status,200);
    assert.equal(createMemoryUsage().text(dir,'next-new','/new/project'),'');
  }finally{await dispose();}
}));

test('project defaults override shared defaults, stay in scope, and explicit selections take precedence',()=>withDir(async dir=>{
  const usage=createMemoryUsage(),base={slug:'topic',version:'v1-12345678',title:'Topic',truncated:false};
  await usage.bindDefault(dir,'',{...base,scope:'',title:'SHARED DEFAULT',text:'LEGACY BODY MUST NOT BE INJECTED'});
  await usage.bindDefault(dir,'/A',{...base,scope:'/A',title:'A DEFAULT',text:'LEGACY BODY MUST NOT BE INJECTED'});
  assert.match(usage.text(dir,'a','/A'),/A DEFAULT/);
  assert.doesNotMatch(usage.text(dir,'b','/B'),/A DEFAULT/);
  assert.match(usage.text(dir,'b','/B'),/SHARED DEFAULT/);
  await usage.bind(dir,'a',{...base,scope:'/A',title:'EXPLICIT',text:'LEGACY BODY MUST NOT BE INJECTED'});
  assert.match(usage.text(dir,'a','/A'),/EXPLICIT/);
  assert.doesNotMatch(usage.text(dir,'a','/A'),/LEGACY BODY/);
  await usage.bind(dir,'a',null);
  assert.match(usage.text(dir,'a','/A'),/A DEFAULT/);
  await usage.bindDefault(dir,'/A',null);
  assert.match(usage.text(dir,'another-a','/A'),/SHARED DEFAULT/);
  await usage.list(dir);
}));
