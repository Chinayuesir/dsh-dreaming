/** Lead → bounded analyzer batches → one organizer → publish. */
import { randomUUID } from 'node:crypto';

export const WORKFLOW_STAGES = Object.freeze([
  { key: 'lead', label: 'Lead：输入规划与批次调度', ready: true },
  { key: 'transcripts', label: '完整会话导出与增量筛选', ready: true },
  { key: 'analyze', label: 'Analyzer：验证、丰富、组织记忆', ready: true },
  { key: 'organize', label: 'Organizer：全局去重与索引', ready: true },
  { key: 'version', label: '记忆快照与版本发布', ready: true },
  { key: 'reader', label: '后续会话只读记忆接入', ready: true },
].map(Object.freeze));

export class NotImplementedError extends Error {
  constructor(adapter) {
    super(`Dreaming v2 TODO: implement ${adapter}`);
    this.name = 'NotImplementedError';
  }
}

const missing = (name) => async () => { throw new NotImplementedError(name); };

/** Explicit integration boundaries; calling the unfinished workflow cannot succeed. */
export function createUnimplementedAdapters() {
  return {
    sessions: { listFinished: missing('sessions.listFinished') },
    analyzer: { run: missing('analyzer.run') },
    organizer: { run: missing('organizer.run') },
    memory: {
      snapshot: missing('memory.snapshot'), begin: missing('memory.begin'),
      commit: missing('memory.commit'), discard: missing('memory.discard'),
      reader: missing('memory.reader'),
    },
  };
}

/** Lead only sees identifiers and paths; never accepts transcript bodies. */
export function planLead(inputs, { batchSize = 20 } = {}) {
  if (!Array.isArray(inputs)) throw new TypeError('sessions.listFinished must return an array');
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 20) {
    throw new RangeError('batchSize must be 1..20');
  }
  const seen = new Set();
  const references = inputs.map((input) => {
    if (!input || typeof input.id !== 'string' || !input.id ||
        typeof input.path !== 'string' || !input.path || seen.has(input.id)) {
      throw new TypeError('Each finished input needs a unique id and a transcript path');
    }
    seen.add(input.id);
    return Object.freeze({ id: input.id, path: input.path });
  });
  const batches = [];
  for (let i = 0; i < references.length; i += batchSize) batches.push(references.slice(i, i + batchSize));
  return { inputsExpected: references.length, batches };
}

function requireAdapters(adapters) {
  for (const [group, names] of Object.entries({
    sessions: ['listFinished'], analyzer: ['run'], organizer: ['run'],
    memory: ['snapshot', 'begin', 'commit', 'discard', 'reader'],
  })) {
    for (const name of names) {
      if (typeof adapters?.[group]?.[name] !== 'function') throw new NotImplementedError(`${group}.${name}`);
    }
  }
}

/**
 * Run exactly once: metadata -> snapshot -> analyze batches -> organize -> commit.
 * begin() owns a staged copy, never the published memory directory. commit() must
 * compare baseVersion and atomically publish; discard() must preserve published data.
 * Analyzer receives a scoped writer, not arbitrary host filesystem/tool access.
 */
export async function runDreaming(adapters, options = {}) {
  requireAdapters(adapters);
  const { signal, batchSize = 20, selection = {} } = options;
  const check = () => signal?.throwIfAborted();
  const runId = randomUUID();
  check();
  const plan = planLead(await adapters.sessions.listFinished(selection, { signal }), { batchSize });
  if (plan.inputsExpected && adapters.lead) {
    const references = plan.batches.flat();
    const planned = await adapters.lead.plan(references, batchSize);
    const batches = planned?.batches;
    if (!Array.isArray(batches) || batches.some(batch => !Array.isArray(batch) || !batch.length || batch.length > batchSize) ||
        JSON.stringify(batches.flat()) !== JSON.stringify(references.map(input => input.id))) {
      throw Error('Lead 返回的计划必须按顺序覆盖每份会话且只分析一次');
    }
    const byId = new Map(references.map(input => [input.id, input]));
    plan.batches = batches.map(batch => batch.map(id => byId.get(id)));
  }
  const report = {
    runId, status: 'running', inputsExpected: plan.inputsExpected, inputsProcessed: 0,
    failures: [], organized: false, indexEntries: null, changes: [], version: null,
  };
  if (!plan.inputsExpected) return { ...report, status: 'empty' };
  check();
  const snapshot = await adapters.memory.snapshot({ runId, signal });
  if (!snapshot?.version) throw new Error('memory.snapshot must return an existing version identifier');
  const stage = await adapters.memory.begin({ runId, baseVersion: snapshot.version, signal });
  let committed = false;
  try {
    for (const batch of plan.batches) {
      check();
      // All tasks settle before rollback or the next batch: no writers outlive cleanup.
      const results = await Promise.allSettled(batch.map(async (input) => {
        const result = await adapters.analyzer.run({ input, stage, runId, signal });
        if (typeof result?.summary !== 'string' || !result.summary.trim()) {
          throw new Error('Analyzer must return a nonempty summary');
        }
        return result;
      }));
      for (const [index, result] of results.entries()) {
        const input = batch[index];
        check();
        if (result.status === 'fulfilled') {
          // Only successful results reach the writer. A write failure aborts the staged run.
          await adapters.analyzer.apply?.({ input, stage, result: result.value, signal });
          report.inputsProcessed++;
        } else report.failures.push({ input: input.id, reason: String(result.reason?.message ?? result.reason) });
      }
      check();
    }
    if (!report.inputsProcessed) return { ...report, status: 'failed' };
    // Organizer executes once after the final batch. Result strings are data only.
    const result = await adapters.organizer.run({ stage, runId, signal });
    if (!Number.isInteger(result?.indexEntries) || result.indexEntries < 0 ||
        !Array.isArray(result.changes) || !result.changes.every((item) => typeof item === 'string')) {
      throw new Error('Organizer must return { indexEntries: nonnegative integer, changes: string[] }');
    }
    check();
    report.organized = true;
    report.indexEntries = result.indexEntries;
    report.changes = result.changes;
    report.status = report.failures.length ? 'partial' : 'complete';
    const version = await adapters.memory.commit({ stage, baseVersion: snapshot.version, report, signal });
    if (version?.status === 'review' && version.draftId) { committed = true; return {...report,...version}; }
    if (typeof version !== 'string' || !version) throw new Error('memory.commit must return a version identifier');
    committed = true;
    return { ...report, version };
  } finally {
    if (!committed) await adapters.memory.discard({ stage, runId });
  }
}

/** Future chat sessions receive only this surface, pinned to a published version. */
export async function openMemoryReader(memory, version) {
  if (typeof version !== 'string' || !version) throw new TypeError('A published version is required');
  const reader = await memory.reader({ version });
  if (typeof reader?.read !== 'function' || typeof reader?.list !== 'function') {
    throw new Error('memory.reader must return read/list functions');
  }
  return Object.freeze({ version, read: (...args) => reader.read(...args), list: (...args) => reader.list(...args) });
}
