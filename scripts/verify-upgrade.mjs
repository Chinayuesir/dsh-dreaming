import {readFile,writeFile,mkdir,readdir,mkdtemp,rm} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {Readable} from 'node:stream';
import assert from 'node:assert/strict';
async function plugin(base){
 const url=pathToFileURL(base+'/index.js');
 const code=(await readFile(url,'utf8')).replace("import { defineTool } from '@deepseek-ai/dsh-tools';",'const defineTool=x=>x;').replace("import { createUserMessage } from '@deepseek-ai/dsh-llm';",'const createUserMessage=x=>({...x,id:randomUUID(),role:"user"});').replace(/'(\.\/workflow\/[^']+)'/g,(_,p)=>JSON.stringify(new URL(p,url).href)).replaceAll('import.meta.url',JSON.stringify(url.href))+'\nexport {readStore,readNote,writeNote,buildWeb};';
 return import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
}
async function snapshot(dir,prefix=''){const result={};for(const entry of await readdir(dir,{withFileTypes:true})){const rel=join(prefix,entry.name),path=join(dir,entry.name);if(entry.isDirectory())Object.assign(result,await snapshot(path,rel));else result[rel]=createHash('sha256').update(await readFile(path)).digest('hex');}return result;}
if (!process.argv[2] || !process.argv[3]) throw Error('Usage: node scripts/verify-upgrade.mjs <old-plugin-directory> <new-plugin-directory>');
const old=await plugin(resolve(process.argv[2])),fresh=await plugin(resolve(process.argv[3]));
const dir=await mkdtemp(join(tmpdir(),'dreaming-upgrade-data-')),memory=join(dir,'自定义记忆目录'),state=join(dir,'state');
await mkdir(join(memory,'notes'),{recursive:true});await mkdir(state);
await writeFile(join(memory,'notes','topic.md'),'# 旧版用户主题\nSummary: 原有摘要\n\n## Facts\n- 保留的原始事实 (old-chat event 7) (2026-11-10)\n');
let note=await old.readNote(memory,'topic');await old.writeNote(memory,{action:'save',name:'topic',revision:note.revision,content:note.content+'\n用户手工追加内容。\n'});
const pointer=JSON.parse(await readFile(join(memory,'current.json'),'utf8'));
await writeFile(join(memory,'versions',pointer.version,'processed.json'),JSON.stringify({'old-chat':'original-fingerprint'}));
const model={provider:'original-provider',model:'original-model'},schedule={enabled:true,time:'01:00',lastSlot:'2099-01-01T00:00:00.000Z'};
await writeFile(join(state,'dreaming-model.json'),JSON.stringify(model));await writeFile(join(state,'dreaming-schedule.json'),JSON.stringify(schedule));
await writeFile(join(state,'dreaming-last-job.json'),JSON.stringify({id:'old-job',status:'complete',message:'旧任务完成'}));
const oldStore=await old.readStore(memory),before=await snapshot(dir);
let route;const hooks={},registered=[];
const ctx={tools:{register:t=>{registered.push(t);return()=>{}}},on:(name,fn)=>{hooks[name]=fn;return()=>{}},webServer:{register:r=>{route=r.handler;return()=>{}}},connection:{requestRejection:()=>undefined},agentDefaultModel:{currentSelection:()=>({provider:'fallback',model:'fallback'})},sessionQuery:{listSessions:async()=>[]}};
const dispose=fresh.apply(ctx,{memoryDir:memory,stateDir:state});
async function get(url){let text,status;const req=Readable.from([]);Object.assign(req,{url,method:'GET',headers:{host:'localhost'}});await route(req,{writeHead:s=>{status=s},end:v=>{text=v}});assert.equal(status,200);return JSON.parse(text);}
try{
 assert.deepEqual((await get('/dreaming/api/model')).configured,model);
 assert.deepEqual(await get('/dreaming/api/schedule'),schedule);
 assert.equal((await get('/dreaming/api/job')).id,'old-job');
 const store=await get('/dreaming/api/store');assert.equal(store.memoryDir??store.baseDir,memory);assert.deepEqual(store.notes,JSON.parse(JSON.stringify(oldStore.notes)));
 const versions=await get('/dreaming/api/versions');assert(versions.versions.length>=2);
 const exec={agent:{session:{id:'new-chat',header:{cwd:'/new-workspace'},seq:0,surface:{nodes:[]},eventAt:()=>undefined}},signal:new AbortController().signal};
 const decision=await hooks['agent/pre-step'](exec,async()=>({kind:'enter',messages:[]}));assert.match(decision.messages[0].content[0].text,/原有摘要/);
 assert.deepEqual(await snapshot(dir),before,'activation, catalog and UI reads must not rewrite any old file');
 const read=JSON.parse(await registered.find(t=>t.name==='dreaming_memory').execute({slug:'topic',scope:'shared'},exec));assert.match(read.text,/用户手工追加内容/);
 const after=await snapshot(dir);for(const [p,hash]of Object.entries(before))assert.equal(after[p],hash,p);
 // Switching code back to 0.4.0 still reads exactly the original current version.
 assert.deepEqual(await old.readStore(memory),oldStore);
 console.log('PASS: old-release-generated memory opens with the candidate; custom root, topic text, history, processed fingerprints, chosen model, enabled schedule and previous job preserved; every existing file unchanged; v0.4.0 rollback still reads original data.');
}finally{await dispose();await rm(dir,{recursive:true,force:true});}
