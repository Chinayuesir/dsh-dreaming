import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { memoryInjection, MEMORY_SOURCE } from './injection.js';

const createUserMessage = input => ({...input,role:'user',id:randomUUID()});
function fixture() {
  const events=[];
  const session={seq:0,surface:{nodes:[]},eventAt:index=>events[index]};
  const sections=[{name:'梦境记忆 · 目录',text:'主题入口；正文按需读取。'}];
  const inject=(decision={kind:'enter',messages:[]}, nextSections=sections)=>memoryInjection({sections:nextSections,agent:{session},decision,createUserMessage});
  const commit=message=>{events.push({seq:session.seq,type:'user/message',data:message});session.surface.nodes.push(session.seq++);};
  return {session,sections,inject,commit};
}

test('native snapshot preserves user messages, deduplicates only committed visible context, and survives retries',()=>{
  const {inject,commit}=fixture();
  const user=createUserMessage({content:[{type:'text',text:'帮我继续项目'}],source:{kind:'human'}});
  const decision={kind:'enter',messages:[user],custom:'keep'};
  const first=inject(decision);
  assert.equal(first.custom,'keep');assert.equal(first.messages[0],user);
  const memory=first.messages[1];
  assert.equal(memory.source.kind,MEMORY_SOURCE);assert.equal(memory.source.form,'snapshot');
  assert.equal(memory.content[0].text,memory.source.sections.map(s=>s.name+'\n'+s.text).join('\n\n'));
  assert.equal(inject(first).messages[1].id,memory.id,'pending admission is idempotent');
  assert.equal(inject(decision).messages.length,2,'abandoned uncommitted attempt does not consume injection');
  commit(memory);
  assert.equal(inject(decision),decision,'same snapshot is not repeated after a tool round');
  assert.deepEqual(inject(first).messages,[user],'pending duplicate removed if snapshot was committed');
});

test('compaction, rewind and changed references refresh native context without process-local flags',()=>{
  const {session,sections,inject,commit}=fixture();
  commit(inject().messages[0]);
  session.surface.nodes=[];
  assert.equal(inject().messages.length,1,'compacted snapshot must return');
  session.surface.nodes=[0];
  const updated=[...sections,{name:'优先查阅主题',text:'新版本主题引用'}];
  const decision=inject(undefined,updated);
  assert.equal(decision.messages.length,1);commit(decision.messages[0]);
  assert.equal(inject(undefined,updated).messages.length,0);
  session.surface.nodes=[0];
  assert.equal(inject(undefined,updated).messages.length,1,'rewind sees the older visible snapshot');
  const empty=[{name:'可用记忆目录',text:'暂无已发布记忆'}];
  assert.equal(inject(undefined,empty).messages[0].source.sections[0].text,'暂无已发布记忆');
});
