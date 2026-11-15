import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomic, json, redact } from './runtime.js';

const MAX_RUNS = 20;
const MAX_ENTRIES = 300;
// Diagnostic summaries only. Never pass prompts, transcripts or model output here.
const clean = value => redact(String(value ?? '')).replace(/https?:\/\/\S+/g, '[地址已省略]')
  .split(/\r?\n/)[0].slice(0, 300);

export function createRunLog(path, logger) {
  let runs = [], storageError = '', pending = Promise.resolve(), saving;
  const persist = () => {
    const value = JSON.stringify(runs);
    pending = pending.then(async () => {
      await mkdir(dirname(path), {recursive: true, mode: 0o700});
      await atomic(path, value);
      storageError = '';
    }).catch(() => {
      storageError = '日志暂时无法写入磁盘，本次进程内仍可查看。请检查 DSH 状态目录权限。';
      logger?.warn?.('[dreaming] ' + storageError);
    });
    return pending;
  };
  const ready = json(path, []).then(value => {
    if (!Array.isArray(value) || value.some(run => !run || typeof run.id !== 'string' || !Array.isArray(run.entries))) throw Error('Invalid log file');
    runs = value.slice(0, MAX_RUNS);
    for (const run of runs) {
      if (run.status === 'running') {
        run.status = 'interrupted';
        run.finishedAt = new Date().toISOString();
        run.entries.push({time: run.finishedAt, phase:'system', level:'warn', message:'桌面端退出或插件重载，上次任务已中断。'});
        run.entries = run.entries.slice(-MAX_ENTRIES);
      }
    }
  }).catch(() => { runs = []; storageError = '旧日志无法读取，新任务仍可记录日志。'; });
  const scheduleSave = () => {
    if (saving) return;
    saving = setTimeout(() => { saving = null; void persist(); }, 200);
    saving.unref?.();
  };
  return {
    async begin({id = randomUUID(), trigger = 'tool'} = {}) {
      await ready;
      const run = {id, trigger, status:'running', startedAt:new Date().toISOString(), entries:[], dropped:0};
      runs.unshift(run);
      // Keep active tasks even when many tool invocations overlap.
      runs = runs.filter((item, index) => index < MAX_RUNS || item.status === 'running');
      const write = (phase, message, level = 'info') => {
        run.entries.push({time:new Date().toISOString(), phase, level, message:clean(message)});
        if (run.entries.length > MAX_ENTRIES) { run.entries.shift(); run.dropped++; }
        scheduleSave();
      };
      write('system', '任务开始');
      return {
        write,
        model(selection) {
          run.model = {provider:clean(selection.provider), model:clean(selection.model)};
          write('system', `使用模型 ${run.model.provider} / ${run.model.model}`);
        },
        async finish(status, message) {
          run.status = status;
          run.finishedAt = new Date().toISOString();
          write('system', message, status === 'failed' ? 'error' : ['partial','cancelled'].includes(status) ? 'warn' : 'info');
          clearTimeout(saving); saving = null;
          await persist();
        },
      };
    },
    async review(id,status,message) {
      await ready;
      const run = runs.find(run=>run.id === id);
      if (!run) return;
      run.status=status;run.reviewedAt=new Date().toISOString();
      run.entries.push({time:run.reviewedAt,phase:'publishing',level:'info',message:clean(message)});
      if(run.entries.length>MAX_ENTRIES){run.entries.shift();run.dropped++;}
      await persist();
    },
    async read(id) {
      await ready;
      const selected = id ? runs.find(run => run.id === id) : runs[0];
      return {runs:runs.map(({entries, ...summary}) => summary), selected:selected ?? null,
        storageError, limits:{runs:MAX_RUNS, entries:MAX_ENTRIES}};
    },
  };
}
