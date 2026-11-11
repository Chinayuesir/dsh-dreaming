import { randomUUID } from 'node:crypto';

const MAX_ROUNDS = 24;
const SUBMIT = 'submit_result';
const RESULT_FORMAT = `Once all required reads are complete, call ${SUBMIT} once, on its own, with the complete result. If tool submission is unavailable, return exactly one valid JSON object matching the requested shape, without explanatory text.`;
const source = { kind: 'plugin:dsh-dreaming' };
const message = (role, content, extra = {}) => ({ id: randomUUID(), role, content, source, ...extra });
const text = value => [{ type: 'text', text: value }];
export const objectSchema = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const string = { type: 'string' };
const offset = { type: 'integer', minimum: 0 };

export function makeTool(name, description, parameters, invoke) {
  return { name, description, parameters, invoke };
}

function parseObject(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch { return null; }
}

function parseResult(raw) {
  const direct = parseObject(raw);
  if (direct) return direct;
  const wrapped = raw.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (wrapped) return parseObject(wrapped[1]);
  const fenced = [...raw.matchAll(/^[ \t]*```(?:json)?[ \t]*\r?\n([\s\S]*?)^[ \t]*```[ \t]*\r?$/gim)];
  return fenced.length === 1 ? parseObject(fenced[0][1]) : null;
}

/** Model conversations can only call the capabilities explicitly supplied here. */
export async function worker(ctx, selection, system, task, tools, resultSchema, signal, log = () => {}) {
  const history = [message('user', text(JSON.stringify(task)))];
  const declared = tools.map(({name, description, parameters}) => ({name, description, parameters}));
  declared.push({ name: SUBMIT, description: 'Submit the final result to the host after completing all required reads.', parameters: resultSchema });
  let retriedFormat = false;
  for (let turn = 0; turn < MAX_ROUNDS; turn++) {
    signal?.throwIfAborted();
    let raw = '', finish, replayState;
    const blocks = new Map();
    log(`第 ${turn + 1} 轮请求模型，等待回复`);
    const waitingSince = Date.now();
    const heartbeat = setInterval(() => log(`模型调用中，已等待 ${Math.floor((Date.now() - waitingSince) / 1000)} 秒`), 30_000);
    heartbeat.unref?.();
    try {
    for await (const part of ctx.llm.stream({
      ...selection, system: `${system}\n${RESULT_FORMAT}`, messages: history, tools: declared, maxTokens: 8192, signal,
    })) {
      signal?.throwIfAborted();
      if (part.type === 'text-delta') raw += part.text;
      if (part.type === 'block-end') blocks.set(part.index, part.block);
      if (part.type === 'finish') ({reason: finish, replayState} = part);
    }
    } finally { clearInterval(heartbeat); }
    const content = [...blocks.entries()].sort(([a], [b]) => a - b).map(([, block]) => block);
    const calls = content.filter(block => block.type === 'tool-call');
    const modelSource = { kind: 'model', ...selection, replayState };
    if (!calls.length && finish?.kind && finish.kind !== 'stop') throw Error('模型未正常完成 · ' + finish.kind);
    if (calls.length && finish?.kind !== 'tool-calls') throw Error('模型工具调用未完整结束');
    const submitted = calls.some(call => call.name === SUBMIT);
    if (!calls.length || submitted) {
      const assembled = content.filter(block => block.type === 'text').map(block => block.text).join('');
      const reply = (assembled || raw).trim();
      // A submission cannot rely on read calls made in the same response.
      const result = submitted ? (calls.length === 1 && parseObject(calls[0].arguments)) : parseResult(reply);
      if (result) { log('收到结构化结果，开始核对'); return result; }
      if (retriedFormat || turn + 1 === MAX_ROUNDS) {
        throw Error('模型未能提交有效的 JSON 结果。请重试，或在梦境配置中切换模型后再运行。');
      }
      retriedFormat = true;
      log('结果格式不正确，正在请求模型纠正一次', 'warn');
      // Never replay malformed tool arguments to a provider on the correction turn.
      if (!submitted && reply) {
        history.push(message('assistant', assembled ? content : text(reply), {
          source: assembled ? modelSource : { kind: 'model', ...selection },
        }));
      }
      history.push(message('user', text(`The result could not be accepted. Use the information already gathered and submit the result again. ${RESULT_FORMAT}`)));
      continue;
    }
    if (calls.length > 50) throw Error('单轮模型工具调用过多');
    log(`模型请求读取资料，共 ${calls.length} 次工具调用`);
    history.push(message('assistant', content, { source: modelSource }));
    for (const call of calls) {
      signal?.throwIfAborted();
      let output, isError = false;
      try {
        const tool = tools.find(candidate => candidate.name === call.name);
        if (!tool) throw Error('此能力未授权');
        output = await tool.invoke(JSON.parse(call.arguments));
      } catch (error) {
        output = {error: error.message}; isError = true;
        log('读取资料失败：' + error.message, 'warn');
      }
      history.push(message('tool', text(JSON.stringify(output)), {toolCallId: call.id, toolName: call.name, isError}));
    }
  }
  throw Error('分析达到工具调用轮次预算');
}

/** Consecutive pages make it possible to verify full reads before accepting output. */
export function pageReader() {
  const offsets = new Map();
  return {
    page(key, body, start) {
      if (!Number.isInteger(start) || start < 0 || start > body.length) throw Error('无效的读取位置');
      if (start > (offsets.get(key) ?? 0)) throw Error('请按 nextOffset 顺序读取，避免跳过内容');
      const page = body.slice(start, start + 24000);
      const end = start + page.length;
      offsets.set(key, Math.max(end, offsets.get(key) ?? 0));
      return {text: page, nextOffset: end < body.length ? end : null, totalChars: body.length};
    },
    complete: (key, body) => offsets.has(key) && offsets.get(key) >= body.length,
  };
}

export function memoryTools(store, read, pages) {
  return [
    makeTool('list_memory', 'List wiki topics and their descriptions. Use offset 0 first.', objectSchema({offset}), ({offset}) => {
      if (!Number.isInteger(offset) || offset < 0 || offset > store.notes.length) throw Error('无效的目录位置');
      const notes = store.notes.slice(offset, offset + 40).map(({slug, title, summary}) => ({slug, title, summary}));
      return {notes, nextOffset: offset + notes.length < store.notes.length ? offset + notes.length : null};
    }),
    makeTool('read_memory', 'Read a topic by listed slug. Start at offset 0 and continue using nextOffset until null.', objectSchema({slug: string, offset}), async ({slug, offset}) => {
      if (!store.notes.some(note => note.slug === slug)) throw Error('未找到记忆主题');
      const content = await read(slug);
      return pages.page(slug, content, offset);
    }),
  ];
}

export function transcriptTool(body, pages) {
  return makeTool('read_transcript', 'Read your assigned transcript only. Start at offset 0 and continue using nextOffset until null.', objectSchema({offset}), ({offset}) => pages.page('transcript', body, offset));
}
