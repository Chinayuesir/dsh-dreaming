import test from 'node:test';
import assert from 'node:assert/strict';
import { runDreaming, createUnimplementedAdapters, openMemoryReader } from './index.js';

function fixture(count = 3) {
  const events = [];
  const adapters = {
    sessions: { listFinished: async () => Array.from({ length: count }, (_, i) => ({ id: String(i), path: `/transcripts/${i}` })) },
    analyzer: { run: async ({ input }) => { events.push(`analyze:${input.id}`); return { summary: input.id }; } },
    organizer: { run: async () => { events.push('organize'); return { indexEntries: 1, changes: ['merged'] }; } },
    memory: {
      snapshot: async () => { events.push('snapshot'); return { version: 'v1' }; },
      begin: async () => { events.push('begin'); return {}; },
      commit: async ({ baseVersion }) => { assert.equal(baseVersion, 'v1'); events.push('commit'); return 'v2'; },
      discard: async () => { events.push('discard'); },
      reader: async () => ({ read: async () => 'note', list: async () => ['topic'], write: () => assert.fail('write exposed') }),
    },
  };
  return { adapters, events };
}

test('one failed analyzer does not stop later batches; organizer runs once before commit', async () => {
  const { adapters, events } = fixture();
  const original = adapters.analyzer.run;
  adapters.analyzer.run = async (task) => { if (task.input.id === '1') throw Error('bad transcript'); return original(task); };
  const report = await runDreaming(adapters, { batchSize: 1 });
  assert.equal(report.status, 'partial');
  assert.equal(report.inputsProcessed, 2);
  assert.equal(report.failures[0].input, '1');
  assert.deepEqual(events, ['snapshot', 'begin', 'analyze:0', 'analyze:2', 'organize', 'commit']);
});

test('organizer failure discards staged writes without publishing', async () => {
  const { adapters, events } = fixture();
  adapters.organizer.run = async () => { throw Error('invalid links'); };
  await assert.rejects(runDreaming(adapters), /invalid links/);
  assert.equal(events.at(-1), 'discard');
  assert.equal(events.includes('commit'), false);
});

test('cancellation waits for all active analyzers before discarding', async () => {
  const { adapters, events } = fixture(2);
  const abort = new AbortController();
  adapters.analyzer.run = async ({ input }) => {
    if (input.id === '0') abort.abort();
    await new Promise((resolve) => setTimeout(resolve, 5));
    events.push(`settled:${input.id}`);
    return { summary: 'done' };
  };
  await assert.rejects(runDreaming(adapters, { signal: abort.signal }), { name: 'AbortError' });
  assert.deepEqual(events.slice(-3), ['settled:0', 'settled:1', 'discard']);
});

test('unfinished adapters fail explicitly; reader exposes no mutation operations', async () => {
  await assert.rejects(runDreaming(createUnimplementedAdapters()), { name: 'NotImplementedError' });
  const { adapters } = fixture();
  const reader = await openMemoryReader(adapters.memory, 'v2');
  assert.deepEqual(Object.keys(reader), ['version', 'read', 'list']);
  assert.equal(await reader.read('topic'), 'note');
  assert.equal(Object.isFrozen(reader), true);
});
