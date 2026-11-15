import { mkdir, readFile, writeFile, readdir, rename, rm, mkdtemp, unlink, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { runDreaming } from './index.js';
import { LEAD_SYSTEM, LEAD_RESULT, ANALYZER_SYSTEM, ANALYZER_RESULT, ORGANIZER_SYSTEM, ORGANIZER_RESULT } from './prompts.js';
import { worker, pageReader, memoryTools, transcriptTool } from './worker.js';
import { parseDateBounds, sessionTimestamp } from './dates.js';
import { createDraft, pendingDraft, fingerprint } from './review.js';

export const safeSlug = value => typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,79}$/.test(value);
const versionPattern = /^v\d+-[0-9a-f]{8}$/;
const digest = text => createHash('sha256').update(text).digest('hex');
const versionId = () => 'v' + Date.now() + '-' + randomUUID().slice(0, 8);

export async function json(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

export async function atomic(path, value) {
  const temp = path + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temp, value, { flag: 'wx', mode: 0o600 });
    await rename(temp, path);
  } finally { await rm(temp, { force: true }); }
}

export async function published(root, version) {
  const selected = version ?? (await json(join(root, 'current.json'), null))?.version;
  if (!selected) return root;
  if (!versionPattern.test(selected)) throw Error('无效的记忆版本');
  const directory = join(root, 'versions', selected);
  if (!(await lstat(directory)).isDirectory()) throw Error('记忆版本不可用');
  return directory;
}

export async function versions(root) {
  let entries;
  try { entries = await readdir(join(root, 'versions'), { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const history = await Promise.all(entries.filter(entry => entry.isDirectory() && versionPattern.test(entry.name))
    .map(async entry => json(join(root, 'versions', entry.name, 'report.json'), null)));
  return history.filter(Boolean).sort((a, b) => b.version.localeCompare(a.version));
}

async function saveVersion(root, stage, report) {
  const version = versionId();
  await mkdir(join(root, 'versions'), { recursive: true, mode: 0o700 });
  await writeFile(join(stage, 'report.json'), JSON.stringify({ ...report, version, createdAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
  await rename(stage, join(root, 'versions', version));
  return version;
}

export async function publish(root, stage, report, signal) {
  if (!(await json(join(root, 'current.json'), null))) {
    const baseline = await stageCopy(root);
    try { await saveVersion(root, baseline, { kind: 'baseline' }); }
    finally { await rm(baseline, { recursive: true, force: true }); }
  }
  const version = await saveVersion(root, stage, report);
  try {
    signal?.throwIfAborted();
    await atomic(join(root, 'current.json'), JSON.stringify({ version }));
  } catch (error) {
    await rm(join(root, 'versions', version), { recursive: true, force: true });
    throw error;
  }
  return version;
}

export async function stageCopy(root) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const stage = await mkdtemp(join(root, '.stage-'));
  try {
    const source = await published(root);
    const target = join(stage, 'notes');
    await mkdir(target, { mode: 0o700 });
    const entries = await readdir(join(source, 'notes'), { withFileTypes: true }).catch(error => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      await writeFile(join(target, entry.name), await readFile(join(source, 'notes', entry.name)), { mode: 0o600 });
    }
    for (const name of ['_index.md', 'processed.json']) {
      const data = await readFile(join(source, name)).catch(error => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (data) await writeFile(join(stage, name), data, { mode: 0o600 });
    }
    return stage;
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
}

const activeRoots = new Set();
export async function locked(root, work) {
  // Desktop Host owns this store. A PID lock also fences a second Host process.
  if (activeRoots.has(root)) throw Error('记忆库正在整理或编辑中');
  activeRoots.add(root);
  const path = join(root, '.dreaming-writer');
  try {
    await mkdir(root, { recursive: true, mode: 0o700 });
    try { await writeFile(path, String(process.pid), { flag: 'wx', mode: 0o600 }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const pid = Number(await readFile(path, 'utf8'));
      if (!Number.isInteger(pid) || pid < 1) throw Error('记忆库写入锁不可用');
      try { process.kill(pid, 0); }
      catch (failure) {
        if (failure.code !== 'ESRCH') throw failure;
        // Recover a lock left behind by a terminated Host.
        await unlink(path);
        await writeFile(path, String(process.pid), { flag: 'wx', mode: 0o600 });
        try { return await work(); } finally { await unlink(path); }
      }
      throw Error('记忆库正在整理或编辑中');
    }
    try { return await work(); } finally { await unlink(path); }
  } finally { activeRoots.delete(root); }
}

export function redact(value) {
  return value
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]')
    .replace(/\b(?:sk[-_]|gh[pousr]_|github_pat_|AKIA)[A-Za-z0-9_-]{16,}/g, '[REDACTED KEY]')
    .replace(/\bBearer\s+[^\s"',;]+/gi, 'Bearer [REDACTED]')
    .replace(/((?:api[_-]?key|password|secret|access[_-]?token|authorization)["']?\s*[=:]\s*["']?)([^\s,"'}]{4,})/gi, '$1[REDACTED]');
}

function eventText(blocks) {
  return (blocks ?? []).map(block => {
    if (block.type === 'text') return block.text;
    if (block.type === 'tool-call') return `Tool call ${block.name}: ${block.arguments}`;
    return block.type === 'reasoning' ? '' : `[${block.type} attachment]`;
  }).filter(Boolean).join('\n');
}

export function transcript(log, id, skipInherited = false) {
  const lines = [`SESSION ${id}`];
  const inherited = skipInherited ? (log.inheritedEventCount ?? 0) : 0;
  for (const [index, event] of (log.events ?? []).entries()) {
    if (index < inherited) continue;
    const data = event.data ?? {};
    let body, label;
    switch (event.type) {
      case 'user/message': label = 'USER'; body = eventText(data.content); break;
      case 'assistant/message': label = 'AGENT'; body = eventText(data.message?.content); break;
      case 'tool/call': label = 'TOOL CALL ' + data.name; body = data.arguments; break;
      case 'tool/result': label = 'TOOL RESULT'; body = [eventText(data.message?.content), data.error?.message].filter(Boolean).join('\n'); break;
      case 'turn/end': label = 'TURN END'; body = data.reason?.kind; break;
      default: continue;
    }
    if (body) lines.push(`Event ${event.seq ?? index + 1} · ${label}:\n${body}`);
  }
  return redact(lines.join('\n\n'));
}

function lastBoundary(log) {
  return (log.events ?? []).findLast(event => ['turn/start', 'turn/end', 'user/message'].includes(event.type));
}
const closed = surface => lastBoundary(surface)?.type === 'turn/end';
const finished = surface => closed(surface) && lastBoundary(surface).data?.reason?.kind === 'completed';

function validatedNotes(result) {
  if (!Array.isArray(result?.notes) || result.notes.length > 12 || typeof result.summary !== 'string' || !result.summary.trim()) {
    throw Error('Analyzer 返回的记忆格式无效');
  }
  const line = (value, max) => {
    if (typeof value !== 'string' || !value.trim() || value.length > max || /[\r\n]/.test(value)) throw Error('记忆字段无效或超过长度限制');
    return redact(value.trim());
  };
  const seen = new Set();
  return result.notes.map(note => {
    if (!safeSlug(note.slug) || seen.has(note.slug) || !Array.isArray(note.facts) || !note.facts.length || note.facts.length > 30 ||
        !Array.isArray(note.links) || !note.links.every(safeSlug)) throw Error('Analyzer 提议的主题无效');
    seen.add(note.slug);
    return {
      slug: note.slug, title: line(note.title, 160), summary: line(note.summary, 400), links: note.links,
      facts: note.facts.map(fact => ({
        date: /^\d{4}-\d{2}-\d{2}$/.test(fact.date) ? fact.date : new Date().toISOString().slice(0, 10),
        text: line(fact.text, 1500),
      })),
    };
  });
}

async function organize(stage, store, result, helpers) {
  if (!Array.isArray(result?.merges) || !Array.isArray(result?.changes) || !result.links || !result.groups) {
    throw Error('Organizer 返回的整理方案无效');
  }
  const notes = new Map();
  for (const note of store.notes) notes.set(note.slug, {
    ...note, markdown: await helpers.readNoteFile(join(stage, 'notes', note.slug + '.md')),
  });
  const redirects = new Map();
  for (const { from, into } of result.merges) {
    if (from === into || !notes.has(from) || !notes.has(into) || redirects.has(from)) throw Error('Organizer 提议的合并目标无效');
    redirects.set(from, into);
  }
  if ([...redirects.values()].some(target => redirects.has(target))) throw Error('Organizer 合并包含多级重定向');
  for (const [from, into] of redirects) {
    const source = notes.get(from), target = notes.get(into);
    // Carry the complete source body, including any manual content and provenance.
    const sourceBody = source.markdown.replace(/^---\n[\s\S]*?\n---\n/, '').replace(/^# ([^\n]*)/, '### $1');
    target.markdown += '\n\n## 合并来源 · ' + source.title + '\n\n' + sourceBody;
    target.links.push(...source.links);
    notes.delete(from);
  }
  const entries = [];
  for (const note of notes.values()) {
    const proposed = Array.isArray(result.links[note.slug]) ? result.links[note.slug] : [];
    const links = [...new Set([...note.links, ...proposed].map(slug => redirects.get(slug) ?? slug))]
      .filter(slug => notes.has(slug) && slug !== note.slug);
    const group = typeof result.groups[note.slug] === 'string' ? redact(result.groups[note.slug].replace(/[\r\n]/g, ' ').slice(0, 80)) : note.group;
    const text = normalizeNote(note, links, redirects, group);
    await atomic(join(stage, 'notes', note.slug + '.md'), text);
    if (await helpers.readNoteFile(join(stage, 'notes', note.slug + '.md')) !== text) throw Error('记忆写入验证失败');
    entries.push({ ...note, links, group });
  }
  for (const slug of redirects.keys()) await unlink(join(stage, 'notes', slug + '.md'));
  await atomic(join(stage, '_index.md'), helpers.renderIndex(entries));
  const changes = result.changes.filter(change => typeof change === 'string').slice(0, 30).map(change => redact(change.slice(0, 240)));
  return { indexEntries: entries.length, changes: [...changes, ...[...redirects].map(([from, into]) => `合并 ${from} → ${into}`)] };
}

function normalizeNote(note, links, redirects, group) {
  const front = `---\nname: ${note.slug}\ndescription: ${JSON.stringify(note.summary || note.title)}\ngroup: ${JSON.stringify(group || '')}\n---\n`;
  let body = note.markdown.replace(/^---\n[\s\S]*?\n---\n/, '');
  body = body.replace(/^<!-- dreaming:links -->\nLinks: [a-z0-9, -]+\n(?:\[\[[a-z0-9-]+\]\] ?)+\n?/gm, '');
  const seen = new Set();
  let inFacts = false, fence = '';
  body = body.split('\n').filter(line => {
    const marker = line.match(/^\s*(```|~~~)/)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (fence === marker) fence = '';
      return true;
    }
    if (fence) return true;
    if (/^Links: [a-z0-9, -]+$/.test(line)) return false;
    if (/^#+ /.test(line)) inFacts = /^## Facts\s*$/.test(line);
    if (!inFacts || !line.startsWith('- ')) return true;
    if (seen.has(line)) return false;
    seen.add(line);
    return true;
  }).map(line => line.replace(/\[\[([a-z0-9-]+)\]\]/g, (match, slug) => {
    if (redirects.has(slug)) return `[[${redirects.get(slug)}]]`;
    return match;
  })).join('\n');
  return front + body.trimEnd() + (links.length ? '\n\n<!-- dreaming:links -->\nLinks: ' + links.join(', ') + '\n' + links.map(slug => `[[${slug}]]`).join(' ') : '') + '\n';
}

async function collect(ctx, directory, processed, options, signal) {
  // readSession is the complete raw log. readSurface omits compacted history and turn boundaries.
  const target = options.sessionId;
  const single = target !== undefined;
  if (single && (typeof target !== 'string' || !target.trim() || target.length > 200)) throw Error('所选会话 ID 无效');
  const maxSessions = single ? 1 : options.maxSessions ?? 6;
  if (!Number.isInteger(maxSessions) || maxSessions < 1 || maxSessions > 50) throw Error('会话数量须在 1–50 之间');
  const { start, end } = parseDateBounds(single ? {} : options);
  const bounded = Number.isFinite(start) || Number.isFinite(end);
  const records = await ctx.sessionQuery.listSessions(signal);
  const candidates = single ? records.filter(({header}) => header?.id === target && !header.delegationDepth) : records;
  if (single && (!candidates.length || target === options.excludeSessionId)) throw Error('找不到可整理的所选会话');
  const children = new Map();
  for (const {header} of records) {
    if (!header?.parentSession || !header.delegationDepth) continue;
    const list = children.get(header.parentSession) ?? [];
    list.push(header.id);
    children.set(header.parentSession, list);
  }
  const inputs = new Map();
  for (const {header} of candidates) {
    signal.throwIfAborted();
    if (inputs.size >= maxSessions) break;
    if (!header?.id || header.delegationDepth || header.id === options.excludeSessionId) continue;
    if (options.workspace && header.cwd !== options.workspace) {
      if (single) throw Error('所选会话不属于当前项目范围，请切换项目后重试');
      continue;
    }
    const stamp = sessionTimestamp(header);
    if (bounded && (!Number.isFinite(stamp) || stamp < start || stamp > end)) continue;
    try {
      const surface = await ctx.sessionQuery.readSession(header.id);
      if (!finished(surface)) {
        if (single) throw Error('所选会话尚未正常完成，请在它完成后再试');
        continue;
      }
      const pieces = [transcript(surface, header.id)];
      const pending = [...(children.get(header.id) ?? [])], visited = new Set([header.id]);
      let busy = false;
      while (pending.length) {
        signal.throwIfAborted();
        const id = pending.shift();
        if (visited.has(id)) continue;
        visited.add(id);
        const child = await ctx.sessionQuery.readSession(id);
        if (!closed(child)) { busy = true; break; }
        pieces.push(transcript(child, id, true));
        pending.push(...(children.get(id) ?? []));
      }
      if (busy) {
        if (single) throw Error('所选会话有尚未结束的子任务，请稍后再试');
        continue;
      }
      const content = pieces.join('\n\n'), hash = digest(content);
      if (!options.force && processed[header.id] === hash) continue;
      const filename = digest(header.id).slice(0, 24) + '.txt';
      await writeFile(join(directory, filename), content, { mode: 0o400 });
      inputs.set(header.id, { filename, hash });
    } catch (error) {
      signal.throwIfAborted();
      if (single) throw error;
      inputs.set(header.id, { filename: 'unavailable', error: redact(error.message) });
    }
  }
  return inputs;
}

export function defaultModelSelection(ctx) {
  const picked = ctx.agentDefaultModel.currentSelection();
  return {
    provider: picked?.provider ?? picked?.providerId,
    model: picked?.model ?? picked?.modelId,
    ...(picked?.reasoningEffort ? {reasoningEffort: picked.reasoningEffort} : {}),
  };
}

export async function executeDream(ctx, root, options, helpers, progress = () => {}) {
  const timeout = AbortSignal.timeout(20 * 60 * 1000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  return locked(root, async () => {
    if (await pendingDraft(root)) throw Error('请先确认或放弃当前待审核草稿');
    const baseFingerprint = await fingerprint(root);
    const conflicts = [];
    const directory = await mkdtemp(join(tmpdir(), 'dsh-dreaming-'));
    try {
      const processed = Object.assign(Object.create(null), await json(join(await published(root), 'processed.json'), {}));
      const selection = options.modelSelection ?? defaultModelSelection(ctx);
      const ask = (phase, label, system, task, resultSchema, tools = []) => {
        if (!selection.provider || !selection.model) throw Error('请先在 Harness 选择默认模型');
        return worker(ctx, selection, system, task, tools, resultSchema, signal,
          (message, level) => progress(phase, `${label} · ${message}`, level));
      };
      let inputs;
      const adapters = {
        sessions: { listFinished: async () => {
          progress('collecting', '筛选已完成的会话并导出记录');
          inputs = await collect(ctx, directory, processed, options, signal);
          progress('collecting', `筛选完成，${inputs.size} 份会话需要分析`);
          return [...inputs].map(([id, info]) => ({ id, path: info.filename }));
        } },
        lead: { plan: (references, batchSize) => {
          progress('planning', `编排 ${references.length} 份会话`);
          return ask('planning', '编排', LEAD_SYSTEM, { transcripts: references, batchSize }, LEAD_RESULT);
        } },
        memory: {
          snapshot: async () => ({ version: (await json(join(root, 'current.json'), {})).version || 'legacy' }),
          begin: () => stageCopy(root),
          discard: ({ stage }) => rm(stage, { recursive: true, force: true }),
          commit: async ({ stage, report }) => {
            signal.throwIfAborted();
            progress('publishing', '生成变化清单，等待用户确认发布');
            await writeFile(join(stage, 'processed.json'), JSON.stringify(processed), { mode: 0o600 });
            return createDraft(root, stage, { kind: 'dream', ...report, logId:options.logId, model: selection, scope:options.workspace || 'shared' }, conflicts, baseFingerprint);
          },
          reader: version => helpers.memoryReader(root, version),
        },
        analyzer: {
          run: async ({ input, stage }) => {
            progress('analyzing', `会话 ${input.id} · 开始核对证据并提炼记忆`);
            try {
            const info = inputs.get(input.id);
            if (info.error) throw Error(info.error);
            const body = await readFile(join(directory, info.filename), 'utf8');
            const store = await helpers.readStore(stage);
            const pages = pageReader();
            const read = async slug => (await helpers.readNote(stage, slug)).content;
            const result = await ask('analyzing', `会话 ${input.id}`, ANALYZER_SYSTEM, { sessionId: input.id, file: input.path }, ANALYZER_RESULT,
              [transcriptTool(body, pages), ...memoryTools(store, read, pages)]);
            if (!pages.complete('transcript', body)) throw Error('Analyzer 未读完整会话，结果未写入');
            const notes = validatedNotes(result);
            for (const note of notes) {
              if (store.notes.some(existing => existing.slug === note.slug) && !pages.complete(note.slug, await read(note.slug))) {
                throw Error('Analyzer 未读完已有主题 · ' + note.slug);
              }
            }
            return { summary: redact(result.summary), notes, conflicts:result.conflicts ?? [] };
            } catch (error) {
              progress('analyzing', `会话 ${input.id} · ${redact(error.message)}`, 'error');
              throw error;
            }
          },
          apply: async ({ input, stage, result }) => {
            const originalFacts = new Map();
            for (const note of result.notes) originalFacts.set(note.slug, helpers.parseNoteFile(await helpers.readNoteFile(join(stage,'notes',note.slug+'.md')) || '').facts);
            for (const note of result.notes) {
              const path = join(stage, 'notes', note.slug + '.md');
              const markdown = await helpers.readNoteFile(path);
              const merged = helpers.renderNoteFile(note, markdown ? { ...helpers.parseNoteFile(markdown), markdown } : null);
              await atomic(path, merged);
              if (await helpers.readNoteFile(path) !== merged) throw Error('记忆写入验证失败');
            }
            if (!Array.isArray(result.conflicts) || result.conflicts.length > 20) throw Error('冲突提议格式无效');
            for (const item of result.conflicts) {
              if (!safeSlug(item.slug) || ![item.oldFact,item.newFact,item.reason].every(v=>typeof v === 'string' && v.trim() && v.length <= 2000 && !/[\r\n]/.test(v))) throw Error('冲突提议字段无效');
              const note = result.notes.find(note=>note.slug === item.slug);
              const facts = helpers.parseNoteFile(await helpers.readNoteFile(join(stage,'notes',item.slug+'.md')) || '').facts;
              const fresh = note?.facts.find(fact=>fact.text === item.newFact);
              const newFact = fresh ? facts.find(fact=>fact === fresh.text || fact === `${fresh.text} (${fresh.date})`) : null;
              if (!fresh || !newFact || !originalFacts.get(item.slug)?.includes(item.oldFact) || item.oldFact === newFact || /^\[(已被替代|待核实)\]/.test(item.oldFact)) throw Error('冲突必须引用同一主题中的原事实和本次新增事实');
              if (conflicts.some(c=>c.slug === item.slug && [c.oldFact,c.newFact].some(f=>f === item.oldFact || f === newFact))) throw Error('同一事实出现多次冲突提议，请减少整理会话后重试');
              conflicts.push({id:randomUUID(),slug:item.slug,oldFact:item.oldFact,newFact,summary:note.summary,reason:redact(item.reason)});
            }
            processed[input.id] = inputs.get(input.id).hash;
            progress('analyzing', `会话 ${input.id} · 已暂存 ${result.notes.length} 个主题，等待全局整理`);
          },
        },
        organizer: { run: async ({ stage }) => {
          progress('organizing', '合并重复主题并整理索引');
          const store = await helpers.readStore(stage);
          const pages = pageReader();
          const read = async slug => (await helpers.readNote(stage, slug)).content;
          const result = await ask('organizing', '全局整理', ORGANIZER_SYSTEM, { topicCount: store.count }, ORGANIZER_RESULT, memoryTools(store, read, pages));
          for (const note of store.notes) {
            if (!pages.complete(note.slug, await read(note.slug))) throw Error('Organizer 未读完整记忆库，未发布版本');
          }
          const protectedSlugs = new Set(conflicts.map(c=>c.slug));
          if (Array.isArray(result.merges)) result.merges = result.merges.filter(m=>!protectedSlugs.has(m.from) && !protectedSlugs.has(m.into));
          return organize(stage, store, result, helpers);
        } },
      };
      const report = await runDreaming(adapters, { signal, batchSize: 2 });
      return { ...report, model: selection };
    } finally { await rm(directory, { recursive: true, force: true }); }
  }).catch(error => {
    if (timeout.aborted && !options.signal?.aborted) throw Error('整理超过 20 分钟时限，已停止。请减少会话数量或切换模型后重试。');
    throw error;
  });
}
