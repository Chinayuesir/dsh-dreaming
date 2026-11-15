import { readdir, readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises';
import { join, isAbsolute, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { json, atomic, published, locked, publish, stageCopy } from './runtime.js';

const hash = text => createHash('sha256').update(text).digest('hex');
const validId = id => typeof id === 'string' && /^[0-9a-f-]{36}$/.test(id);
export function scopeRoot(base, scope = '') {
  if (!scope || scope === 'shared') return base;
  if (typeof scope !== 'string' || !isAbsolute(scope)) throw Error('项目范围必须是完整工作区路径');
  return join(base, 'projects', hash(resolve(scope)));
}
export async function filesAt(directory) {
  const files = {};
  for (const entry of await readdir(join(directory, 'notes'), {withFileTypes:true}).catch(e => { if (e.code === 'ENOENT') return []; throw e; })) {
    if (entry.isFile() && /^[a-z0-9][a-z0-9-]{0,79}\.md$/.test(entry.name)) files[entry.name.slice(0,-3)] = await readFile(join(directory,'notes',entry.name),'utf8');
  }
  return files;
}
export async function fingerprint(root) {
  const directory = await published(root);
  const files = await filesAt(directory);
  return hash(JSON.stringify([directory, Object.keys(files).sort().map(k=>[k,files[k]]), await json(join(directory,'processed.json'),{})]));
}
export function changesBetween(before, after) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].sort().flatMap(slug => {
    if (before[slug] === after[slug]) return [];
    return [{slug, kind:before[slug] === undefined ? 'added' : after[slug] === undefined ? 'removed' : 'modified', before:before[slug] ?? '', after:after[slug] ?? ''}];
  });
}
export async function pendingDraft(root) {
  const id = (await json(join(root,'pending.json'),{})).id;
  if (!id) return null;
  if (!validId(id)) throw Error('待审核草稿标识无效');
  const draft = await json(join(root,'drafts',id,'draft.json'),null);
  if (!draft) throw Error('草稿记录缺失，请恢复备份后重试');
  return draft;
}
export async function createDraft(root, stage, report, conflicts, baseFingerprint) {
  if (await pendingDraft(root)) throw Error('请先确认或放弃当前待审核草稿');
  const id = randomUUID();
  const before = await filesAt(await published(root));
  const after = await filesAt(stage);
  const draft = {id, createdAt:new Date().toISOString(), baseFingerprint, report, conflicts, changes:changesBetween(before,after)};
  await mkdir(join(root,'drafts'),{recursive:true,mode:0o700});
  await writeFile(join(stage,'draft.json'),JSON.stringify(draft),{mode:0o600});
  await rename(stage,join(root,'drafts',id));
  try { await atomic(join(root,'pending.json'),JSON.stringify({id})); }
  catch(error) { await rm(join(root,'drafts',id),{recursive:true,force:true}); throw error; }
  return {status:'review', draftId:id, version:null};
}
export function resolveConflict(markdown, conflict, decision) {
  const oldLine = '- ' + conflict.oldFact, newLine = '- ' + conflict.newFact;
  const lines = markdown.split('\n');
  if (!lines.includes(oldLine) || !lines.includes(newLine)) throw Error('冲突事实已经变化，请重新整理');
  if (decision === 'keep-old') return lines.filter(line=>line !== newLine).join('\n');
  if (decision === 'replace') return lines.map(line=>line.startsWith('Summary:') && conflict.summary ? 'Summary: ' + conflict.summary : line === oldLine
    ? `- [已被替代] ${conflict.oldFact}\n  替代为：${conflict.newFact}\n  依据：${conflict.reason}` : line).join('\n');
  if (decision === 'uncertain') return lines.map(line=>line.startsWith('Summary:') ? 'Summary: 存在待核实的历史结论，请阅读事实与出处。' : line === oldLine || line === newLine ? '- [待核实] ' + line.slice(2) : line).join('\n');
  throw Error('请为每项冲突选择处理方式');
}
export async function reviewDraft(root, body, helpers) {
  return locked(root, async()=>{
    const draft = await pendingDraft(root);
    if (!draft || body.id !== draft.id) throw Error('草稿已变化，请刷新后重试');
    const source = join(root,'drafts',draft.id);
    if (body.action === 'discard') {
      await rm(join(root,'pending.json'),{force:true});
      await rm(source,{recursive:true,force:true});
      return {status:'discarded'};
    }
    if (body.action !== 'publish' || body.confirm !== true) throw Error('需要明确确认后才能发布');
    if (await fingerprint(root) !== draft.baseFingerprint) throw Error('当前记忆已被编辑或切换版本，请放弃草稿并重新整理，避免覆盖新内容');
    const before = await filesAt(await published(root));
    const after = await filesAt(source);
    for (const conflict of draft.conflicts) after[conflict.slug] = resolveConflict(after[conflict.slug],conflict,body.decisions?.[conflict.id]);
    // A fresh stage keeps failed approval attempts retryable and the preview immutable.
    const stage = await stageCopy(root);
    try {
      await rm(join(stage,'notes'),{recursive:true,force:true});
      await mkdir(join(stage,'notes'),{mode:0o700});
      for (const [slug,text] of Object.entries(after)) await writeFile(join(stage,'notes',slug+'.md'),text,{mode:0o600});
      await writeFile(join(stage,'processed.json'),JSON.stringify(await json(join(source,'processed.json'),{})),{mode:0o600});
      const store = await helpers.readStore(stage);
      await writeFile(join(stage,'_index.md'),helpers.renderIndex(store.notes),{mode:0o600});
      const actualChanges = changesBetween(before,after);
      const version = await publish(root,stage,{...draft.report,actualChanges,reviewedAt:new Date().toISOString(),decisions:body.decisions ?? {},draftId:draft.id});
      await rm(join(root,'pending.json'),{force:true});
      await rm(source,{recursive:true,force:true});
      return {status:draft.report.status, version, actualChanges};
    } finally { await rm(stage,{recursive:true,force:true}); }
  });
}
