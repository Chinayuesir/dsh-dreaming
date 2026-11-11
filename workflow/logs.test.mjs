import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile, readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createRunLog} from './logs.js';

test('logs are bounded, redact credentials and survive restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dreaming-logs-'));
  try {
    const path = join(dir, 'logs.json'), journal = createRunLog(path);
    for (let i = 0; i < 22; i++) {
      const log = await journal.begin({id:String(i), trigger:'manual'});
      log.model({provider:'test', model:'fixture'});
      for (let n = 0; n < 310; n++) log.write('analyzing', `读取第 ${n} 页`);
      log.write('analyzing', 'HTTP 401 api_key=sk-abcdefghijklmnopqr https://example.com/?secret=test\nprivate body', 'error');
      await log.finish('failed', '分析失败');
    }
    const restored = await createRunLog(path).read();
    assert.equal(restored.runs.length, 20);
    assert.equal(restored.selected.id, '21');
    assert.equal(restored.selected.entries.length, 300);
    assert.ok(restored.selected.dropped > 0);
    const raw = await readFile(path, 'utf8');
    assert.doesNotMatch(raw, /abcdefghijkl|private body|example.com/);
    assert.match(raw, /HTTP 401/);
    assert.equal((await journal.read('missing')).selected, null);
    await writeFile(path, JSON.stringify([{...restored.selected, status:'running'}]));
    const interrupted = (await createRunLog(path).read()).selected;
    assert.equal(interrupted.status, 'interrupted');
    assert.match(interrupted.entries.at(-1).message, /中断/);
  } finally { await rm(dir, {recursive:true, force:true}); }
});

test('log disk errors do not turn successful memory publication into a failure', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dreaming-logs-'));
  try {
    const path = join(dir, 'not-a-directory');
    await writeFile(path, 'file');
    const journal = createRunLog(join(path, 'logs.json'));
    const log = await journal.begin();
    await log.finish('complete', '已发布');
    const result = await journal.read();
    assert.equal(result.selected.status, 'complete');
    assert.match(result.storageError, /无法写入/);
  } finally { await rm(dir, {recursive:true, force:true}); }
});
