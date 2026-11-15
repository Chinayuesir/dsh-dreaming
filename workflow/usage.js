import { mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { json, atomic } from './runtime.js';

// Only bounded delivery metadata is logged; never store prompts or full tool replies.
export function createMemoryUsage() {
  const queues = new Map(), caches = new Map();
  function serial(root, work) {
    const task = (queues.get(root) ?? Promise.resolve()).catch(()=>{}).then(work);
    queues.set(root, task);
    return task;
  }
  function bindings(root, filename = 'session-memory.json') {
    const key = root + '\n' + filename;
    if (!caches.has(key)) {
      try { caches.set(key,JSON.parse(readFileSync(join(root,filename),'utf8'))); }
      catch (error) { if (error.code !== 'ENOENT') throw error; caches.set(key,{}); }
    }
    return caches.get(key);
  }
  async function record(root, entry) {
    return serial(root,async()=>{
      await mkdir(root,{recursive:true,mode:0o700});
      const file = join(root,'memory-reads.json');
      const entries = await json(file,[]);
      entries.push({at:new Date().toISOString(),...entry});
      await atomic(file,JSON.stringify(entries.slice(-300)));
    });
  }
  return {
    record,
    async list(root, sessionId, scope = '') {
      await queues.get(root)?.catch(()=>{});
      const entries = await json(join(root,'memory-reads.json'),[]);
      const defaults = bindings(root,'default-memory.json');
      const defaultBinding = defaults[scope || 'shared'] ?? defaults.shared ?? null;
      return {entries:entries.filter(e=>!sessionId || e.sessionId === sessionId).reverse(), binding:sessionId ? bindings(root)[sessionId] ?? null : defaults[scope || 'shared'] ?? null, defaultBinding};
    },
    async bind(root,sessionId,selection) {
      return serial(root,async()=>{
        const next = {...bindings(root)};
        if (selection) next[sessionId] = {...selection,id:randomUUID(),at:Date.now()};
        else delete next[sessionId];
        const bounded = Object.fromEntries(Object.entries(next).sort((a,b)=>b[1].at-a[1].at).slice(0,100));
        await mkdir(root,{recursive:true,mode:0o700});
        await atomic(join(root,'session-memory.json'),JSON.stringify(bounded));
        caches.set(root+'\nsession-memory.json',bounded);
        return bounded[sessionId] ?? null;
      });
    },
    async bindDefault(root,scope,selection) {
      return serial(root,async()=>{
        const next = {...bindings(root,'default-memory.json')};
        const key = scope || 'shared';
        if (selection) next[key] = {...selection,id:randomUUID(),at:Date.now()};
        else delete next[key];
        await mkdir(root,{recursive:true,mode:0o700});
        await atomic(join(root,'default-memory.json'),JSON.stringify(next));
        caches.set(root+'\ndefault-memory.json',next);
        return next[key] ?? null;
      });
    },
    text(root,sessionId,scope = '') {
      const defaults = bindings(root,'default-memory.json');
      const bound = sessionId ? bindings(root)[sessionId] : null;
      const direct = bound && (!bound.scope || bound.scope === scope) ? bound : null;
      const selection = direct || defaults[scope || 'shared'] || defaults.shared;
      if (!selection) return '';
      // Legacy selections may contain text; never inject it or count a reference as a read.
      return `用户选定的优先查阅入口（${direct ? '此对话指定' : '默认主题，适用于未单独指定的对话'}）：\n${JSON.stringify({title:selection.title,slug:selection.slug,scope:selection.scope || 'shared',version:selection.version || ''})}\n这里只提供引用，未读取正文。与当前问题有关时调用只读工具 dreaming_memory，传入上述 slug、scope、version。指定的是固定版本；涉及现状时需读取当前版本核对日期及已被替代／待核实标记。`;
    },
  };
}
