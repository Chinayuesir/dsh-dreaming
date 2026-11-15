'use strict';
const byId = id => document.getElementById(id);
let store, selected, editing = false, lastJob, reading = 0;
let mapGroup;
let currentScope = '', review, targetSession = '', scopeEpoch = 0;
const phases = ['collecting', 'planning', 'analyzing', 'organizing', 'publishing'];
const stateLabels = {
  review:'待审核', discarded:'已放弃', idle: '待运行', running: '运行中', complete: '已完成', partial: '部分完成',
  empty: '无新增会话', failed: '失败', cancelled: '已取消', interrupted: '已中断',
};
const sourceLabels = { environment: '环境变量', profile: '配置文件', saved: '已保存的设置', default: '默认目录' };

async function api(path, body) {
  const requestUrl = '/dreaming/api/' + path + (path.includes('?') ? '&' : '?') + 'scope=' + encodeURIComponent(currentScope);
  const response = await fetch(requestUrl, body === undefined ? undefined : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw Error(data.error || '请求失败 · HTTP ' + response.status);
  return data;
}
function make(tag, text, className) {
  const element = document.createElement(tag);
  if (text) element.textContent = text;
  if (className) element.className = className;
  return element;
}
function show(text, error = false) {
  const notice = byId('status');
  notice.textContent = text;
  notice.classList.toggle('error', error);
  notice.hidden = !text;
}
const fail = error => show(error.message, true);
function dirty() { return editing && byId('content').value !== selected?.content; }
function mayDiscard() { return !dirty() || confirm('放弃尚未保存的修改？'); }
function displayList() {
  const query = byId('q').value.trim().toLowerCase();
  const terms = query.split(/\s+/).filter(Boolean);
  const notes = (store?.notes ?? []).filter(note => terms.every(term=>[note.title, note.slug, note.summary, ...note.facts].join(' ').toLowerCase().includes(term)));
  byId('listCount').textContent = notes.length;
  const list = byId('notes');
  list.replaceChildren();
  for (const note of notes) {
    const button = make('button', '', 'note');
    button.setAttribute('aria-pressed', String(note.slug === selected?.name));
    button.append(make('strong', note.title), make('small', note.summary || note.slug));
    button.onclick = () => openNote(note.slug).catch(fail);
    list.append(button);
  }
  if (!notes.length) list.append(make('p', query ? '没有匹配的记忆。' : '运行一次梦境，生成第一批记忆。', 'muted'));
}
function displayNote() {
  const preview = byId('preview');
  byId('actions').hidden = !selected;
  byId('useMemory').textContent = targetSession ? '供选定对话查阅' : '设为默认参考';
  byId('title').textContent = selected?.title || '选择一条记忆';
  byId('slug').textContent = selected?.name || '';
  byId('edit').hidden = byId('delete').hidden = byId('useMemory').hidden = byId('copyReference').hidden = editing;
  byId('save').hidden = byId('discard').hidden = !editing;
  byId('content').hidden = !editing;
  preview.hidden = editing;
  preview.classList.toggle('empty', !selected);
  preview.replaceChildren();
  if (!selected) {
    preview.append(make('span', '☾'), make('p', '从左侧选择条目，查看会话留下的发现。'));
    return;
  }
  renderMemoryText(preview, selected.content);
  const related = store?.notes.find(note => note.slug === selected.name)?.links ?? [];
  for (const slug of related) {
    const note = store.notes.find(note => note.slug === slug);
    if (!note) continue;
    const button = make('button', note.title, 'note-link');
    button.onclick = () => openNote(slug).catch(fail);
    preview.append(button);
  }
}
function renderMemoryText(container, content) {
  // Render a small Markdown subset through text nodes. Note content is untrusted.
  const lines = content.replace(/^---\n[\s\S]*?\n---\n/, '').split('\n');
  let list;
  for (const line of lines) {
    if (/^# /.test(line) || /^(Links:|\[\[|<!-- dreaming:links -->)/.test(line)) continue;
    if (line.startsWith('- ')) {
      if (!list) { list = make('ul'); container.append(list); }
      const item = make('li', line.slice(2));
      if (line.startsWith('- [已被替代]')) item.className = 'superseded-fact';
      if (line.startsWith('- [待核实]')) item.className = 'uncertain-fact';
      list.append(item);
      continue;
    }
    list = null;
    if (/^#{2,6} /.test(line)) container.append(make('h3', line.replace(/^#+ /, '').replace(/^Facts$/, '记忆与证据')));
    else if (line.trim()) container.append(make('p', line.replace(/^Summary:\s*/, '')));
  }
}
async function openNote(slug) {
  if (!mayDiscard()) return;
  const id = ++reading;
  const result = await api('note?name=' + encodeURIComponent(slug));
  if (id !== reading) return;
  selected = result;
  editing = false;
  displayList();
  displayNote();
  return true;
}
function clearNote() {
  reading++;
  selected = undefined;
  editing = false;
  displayNote();
  displayList();
}
function mapQuery(slug) {
  const query = new URLSearchParams({name:slug});
  if (store.version) query.set('version', store.version);
  return query;
}
function mapSource(source, query) {
  const item = make('details', '', 'map-source');
  const summary = make('summary');
  summary.append(make('strong', source.title), make('small', source.excerpt));
  const body = make('div', '', 'map-source-body');
  const dialogue = make('pre', '', 'map-transcript');
  dialogue.hidden = true;
  dialogue.tabIndex = 0;
  dialogue.setAttribute('aria-label', '原对话正文');
  const status = make('p', '', 'muted');
  status.setAttribute('role', 'status');
  const more = make('button', '继续加载对话');
  more.hidden = true;
  body.append(dialogue, status, more);
  item.append(summary, body);
  let offset = 0, loading = false, loaded = false;
  async function load() {
    if (loading || offset === null) return;
    loading = more.disabled = true;
    status.textContent = '正在读取对话…';
    try {
      const params = new URLSearchParams(query);
      params.set('id', source.id);
      params.set('offset', offset);
      const result = await api('map-source?' + params);
      dialogue.append(document.createTextNode(result.text));
      dialogue.hidden = !dialogue.textContent;
      offset = result.nextOffset;
      loaded = true;
      more.hidden = offset === null;
      more.textContent = '继续加载对话';
      status.textContent = dialogue.hidden ? '这条会话没有可显示的文字。' : offset === null ? '' : '还有后续对话。';
    } catch (error) {
      status.textContent = error.message;
      more.hidden = false;
      more.textContent = '重试读取';
    } finally { loading = more.disabled = false; }
  }
  more.onclick = load;
  item.ontoggle = () => { if (item.open && !loaded) void load(); };
  return item;
}
function mapTopic(note) {
  const item = make('details', '', 'map-topic');
  const summary = make('summary');
  summary.append(make('strong', note.title), make('small', note.summary || note.facts[0] || '展开查看主题内容'),
    make('span', `${note.facts.length} 条记忆 · ${note.links.length} 个主题链接`, 'map-topic-meta'));
  const body = make('div', '', 'map-topic-body');
  item.append(summary, body);
  const query = mapQuery(note.slug);
  async function openInLibrary(slug) {
    if (await openNote(slug)) {
      showTab('library');
      byId('title').scrollIntoView({block:'nearest'});
    }
  }
  let loaded = false, loading = false;
  async function load() {
    if (loaded || loading) return;
    loading = true;
    body.replaceChildren(make('p', '正在读取条目…', 'muted'));
    try {
      const result = await api('note?' + query + '&view=map');
      const preview = make('div', '', 'preview map-note-preview');
      renderMemoryText(preview, result.content);
      const library = make('button', '在记忆库中打开');
      library.onclick = () => openInLibrary(note.slug).catch(fail);
      body.replaceChildren(preview, library);
      const related = note.links.map(slug => store.notes.find(topic => topic.slug === slug)).filter(Boolean);
      if (related.length) {
        const links = make('div', '', 'row wrap');
        for (const topic of related) {
          const button = make('button', topic.title);
          button.onclick = () => openInLibrary(topic.slug).catch(fail);
          links.append(button);
        }
        body.append(make('strong', '相关主题'), links);
      }
      if (result.sources.length) {
        body.append(make('strong', '来源对话'), ...result.sources.map(source => mapSource(source, query)));
      } else {
        body.append(make('p', '这条记忆没有可核对的原对话出处。', 'muted'));
      }
      loaded = true;
    } catch (error) {
      const retry = make('button', '重试读取');
      retry.onclick = load;
      body.replaceChildren(make('p', error.message, 'muted'), retry);
    } finally { loading = false; }
  }
  item.ontoggle = () => { if (item.open) void load(); };
  return item;
}
function displayMap() {
  if (!store || byId('memoryMap').hidden) return;
  const search = byId('mapSearch').value.trim().toLowerCase();
  const groups = new Map();
  for (const note of store.notes) {
    const group = note.group?.trim() || '记忆主题';
    const label = [group, note.title, note.summary, note.slug].join(' ').toLowerCase();
    if (!label.includes(search)) continue;
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(note);
  }
  const status = byId('mapStatus');
  status.hidden = Boolean(groups.size);
  byId('mapTree').hidden = !groups.size;
  if (!groups.size) {
    status.textContent = search ? '没有匹配的主题，试试其他关键词。' : '发布第一批梦境记忆后，这里就会显示主题分支。';
    return;
  }
  if (!groups.has(mapGroup)) mapGroup = groups.keys().next().value;
  byId('mapVersion').textContent = store.version || '初始记忆库';
  byId('mapStats').textContent = `${groups.size} 个分组 · ${[...groups.values()].reduce((sum, notes) => sum + notes.length, 0)} 个主题`;
  const groupList = byId('mapGroups');
  const topicList = byId('mapTopics');
  groupList.replaceChildren();
  function showGroup(group) {
    mapGroup = group;
    for (const button of groupList.children) button.setAttribute('aria-pressed', String(button.dataset.group === group));
    byId('mapGroupLabel').textContent = '主题分支 · ' + group;
    topicList.replaceChildren(...groups.get(group).map(mapTopic));
  }
  for (const [group, notes] of groups) {
    const button = make('button', '', 'map-group');
    button.dataset.group = group;
    button.append(make('span', group), make('span', String(notes.length), 'map-group-count'));
    button.onclick = () => { if (mapGroup !== group) showGroup(group); };
    groupList.append(button);
  }
  showGroup(mapGroup);
}
async function refresh({ settings = false } = {}) {
  const epoch = scopeEpoch;
  const [library, history] = await Promise.all([api('store'), api('versions')]);
  if (epoch !== scopeEpoch) return;
  store = library;
  byId('count').textContent = store.count;
  byId('versionCount').textContent = history.versions.length;
  byId('path').textContent = store.memoryDir;
  byId('source').textContent = sourceLabels[store.source] || store.source;
  if (settings) byId('newPath').value = store.configuredDir || '';
  displayList();
  displayMap();
  const list = byId('versions');
  list.replaceChildren();
  if (!history.versions.length) list.append(make('p', '第一次梦境完成后，版本会出现在这里。', 'muted'));
  for (const version of history.versions) {
    const row = make('div', '', 'row spread version-row');
    const info = make('div');
    const label = { manual: '手动编辑', baseline: '原始记忆库', dream: '梦境整理' }[version.kind] || '梦境整理';
    info.append(make('strong', label), make('div', new Date(version.createdAt).toLocaleString() + ' · ' + version.version, 'muted'));
    if (version.model?.model) info.append(make('div', modelLabel(version.model), 'muted'));
    row.append(info);
    if (version.actualChanges) {
      const changes = make('button','查看变化');
      changes.onclick = ()=>{ showTab('reviewPanel'); displayPublished(version); };
      row.append(changes);
    }
    if (version.version === history.current) row.append(make('span', '当前版本', 'badge'));
    else {
      const button = make('button', '切换到此版本');
      button.onclick = () => perform(button, async () => {
        if (!mayDiscard() || !confirm('切换到此版本？可以随时切回。')) return;
        await api('restore', { version: version.version });
        clearNote();
        await refresh();
        show('已切换记忆版本。');
      });
      row.append(button);
    }
    list.append(row);
  }
}
async function perform(button, action) {
  button.disabled = true;
  try { await action(); } catch (error) { fail(error); }
  finally { button.disabled = false; }
}
function modelLabel(selection) {
  return selection?.provider && selection?.model ? `${selection.provider} / ${selection.model}` : '尚未设置';
}
function displayRunModel({effective, configured}) {
  const mode = configured ? '' : '（跟随 DSH 默认）';
  byId('runModel').textContent = `下次运行模型：${modelLabel(effective)}${mode}`;
}
const dreamModel = byId('dreamModel');
const saveDreamModel = byId('saveDreamModel');
const dreamModelStatus = byId('dreamModelStatus');
const modelValue = ({provider, model}) => JSON.stringify([provider, model]);
let updatingModelSettings = false;

async function loadDreamModels() {
  if (updatingModelSettings) return;
  updatingModelSettings = dreamModel.disabled = saveDreamModel.disabled = true;
  dreamModelStatus.textContent = '正在读取 DSH 模型…';
  try {
    const result = await api('model?catalog=1');
    const {configured, defaultModel, groups, unavailable} = result;
    displayRunModel(result);
    const defaultOption = make('option', `跟随 DSH 默认模型（${modelLabel(defaultModel)}）`);
    defaultOption.value = '';
    dreamModel.replaceChildren(defaultOption);
    for (const provider of groups) {
      const group = make('optgroup');
      group.label = provider.name && provider.name !== provider.id ? `${provider.name}（${provider.id}）` : provider.id;
      for (const model of provider.models) {
        const option = make('option', model.name === model.id ? model.id : `${model.name}（${model.id}）`);
        option.value = modelValue({provider:provider.id, model:model.id});
        group.append(option);
      }
      dreamModel.append(group);
    }
    const messages = [];
    if (configured) {
      const value = modelValue(configured);
      if (![...dreamModel.options].some(option => option.value === value)) {
        const missing = make('option', `${modelLabel(configured)}（当前不可选）`);
        missing.value = value;
        missing.disabled = true;
        dreamModel.append(missing);
        messages.push('已保存的模型当前不可选，请重新选择。');
      }
      dreamModel.value = value;
    }
    if (unavailable.length) messages.push(`暂时无法加载：${unavailable.join('、')}。`);
    if (!groups.length && !messages.length) messages.push('DSH 暂无可选模型，请先在 DSH 中配置。');
    dreamModelStatus.textContent = messages.join(' ');
    dreamModel.disabled = saveDreamModel.disabled = false;
  } catch (error) {
    dreamModelStatus.textContent = `无法读取 DSH 模型。${error.message}`;
  } finally { updatingModelSettings = false; }
}
byId('dreamModelForm').onsubmit = event => {
  event.preventDefault();
  if (saveDreamModel.disabled) return;
  const option = dreamModel.selectedOptions[0];
  if (!option || option.disabled) return;
  const [provider, model] = option.value ? JSON.parse(option.value) : [];
  perform(saveDreamModel, async () => {
    updatingModelSettings = dreamModel.disabled = true;
    try {
      const result = await api('model', {model: provider ? {provider, model} : null});
      displayRunModel(result);
      dreamModelStatus.textContent = '模型已保存，下次整理时生效。';
    } finally { updatingModelSettings = dreamModel.disabled = false; }
  });
};
async function poll() {
  const epoch = scopeEpoch;
  const job = await api('job');
  if (epoch !== scopeEpoch) return;
  const running = job.status === 'running';
  const failed = job.status === 'failed';
  byId('jobBadge').textContent = stateLabels[job.status] || job.status;
  const jobModel = byId('jobModel');
  jobModel.hidden = !job.model?.model;
  jobModel.textContent = jobModel.hidden ? '' : `本次模型：${modelLabel(job.model)}`;
  byId('cancel').hidden = !running;
  byId('cancel').disabled = Boolean(job.cancelling);
  const phaseIndex = phases.indexOf(job.phase);
  let failedPhase = '';
  for (const step of byId('steps').children) {
    const index = phases.indexOf(step.dataset.phase);
    step.classList.toggle('active', running && index === phaseIndex);
    step.classList.toggle('done', index < phaseIndex || ['complete', 'partial'].includes(job.status));
    const isFailed = failed && index === phaseIndex;
    step.classList.toggle('failed', isFailed);
    if (isFailed) failedPhase = step.textContent;
  }
  byId('jobMessage').textContent = (failedPhase ? `失败于「${failedPhase}」：` : '') +
    (job.message || '准备好后开始一次梦境。');
  const report = byId('report');
  report.replaceChildren();
  if (job.report) {
    const { inputsProcessed, inputsExpected, failures, version, changes } = job.report;
    report.append(make('p', '已分析 ' + inputsProcessed + ' / ' + inputsExpected + ' 个会话' + (version ? ' · ' + version : '')));
    for (const item of failures ?? []) report.append(make('p', item.input + ' · ' + item.reason, 'muted'));
    for (const change of changes ?? []) report.append(make('p', change, 'muted'));
  }
  const justFinished = lastJob?.status === 'running' && !running;
  lastJob = job;
  updateRunButton();
  if (justFinished) {
    await refresh();
    await loadReview();
    if (job.status === 'review' && !byId('runPanel').hidden) showTab('reviewPanel');
    if (selected && !editing) {
      try { await openNote(selected.name); } catch { clearNote(); }
    }
  }
}
const tabs = document.querySelectorAll('nav [data-tab]');
let logsData, loadingLogs = false, logPage = null;
const logPageSize = 50;
const logPhases = {system:'任务', collecting:'收集会话', planning:'编排', analyzing:'逐会话分析', organizing:'全局整理', publishing:'发布版本'};
const logTriggers = {manual:'手动整理', scheduled:'夜间整理', tool:'对话工具', api:'接口整理'};
const logLevels = {info:'进展', warn:'警告', error:'报错'};
function logLines(run) {
  return (run?.entries ?? []).map(entry => `${new Date(entry.time).toLocaleString()} [${logPhases[entry.phase] || entry.phase}] [${logLevels[entry.level] || entry.level}] ${entry.message}`).join('\n');
}
function renderLogs() {
  const run = logsData?.selected;
  byId('copyLogs').disabled = !run;
  byId('logSummary').textContent = run ?
    `${stateLabels[run.status] || run.status} · ${logTriggers[run.trigger] || run.trigger} · ${new Date(run.startedAt).toLocaleString()}` +
    (run.model ? ` · ${modelLabel(run.model)}` : '') : '暂无运行日志。新任务开始后会显示在这里。';
  byId('logNotice').textContent = [logsData?.storageError, run?.dropped ? `已省略最早的 ${run.dropped} 条日志。` : ''].filter(Boolean).join(' ');
  const entries = (run?.entries ?? []).filter(entry => byId('logLevel').value === 'all' || entry.level !== 'info');
  const pageCount = Math.max(1, Math.ceil(entries.length / logPageSize));
  const page = logPage === null ? pageCount - 1 : Math.min(logPage, pageCount - 1);
  const list = byId('logEntries');
  list.replaceChildren();
  for (const entry of entries.slice(page * logPageSize, (page + 1) * logPageSize)) {
    const row = make('li', '', 'log-entry');
    row.dataset.level = entry.level;
    const time = make('time', new Date(entry.time).toLocaleTimeString());
    time.dateTime = entry.time;
    time.title = new Date(entry.time).toLocaleString();
    row.append(time, make('span', logPhases[entry.phase] || entry.phase), make('span', `${entry.level === 'info' ? '' : (logLevels[entry.level] || entry.level) + ' · '}${entry.message}`));
    list.append(row);
  }
  if (!entries.length) list.append(make('li', run ? '没有符合条件的日志。' : '从「梦境运行」开始整理一个会话。', 'log-empty'));
  byId('logPage').textContent = `第 ${page + 1} / ${pageCount} 页 · ${entries.length} 条` + (logPage === null ? ' · 跟随最新' : '');
  byId('logPrev').disabled = page === 0;
  byId('logNext').disabled = page >= pageCount - 1;
  byId('logPrev').onclick = () => { logPage = Math.max(0, page - 1); renderLogs(); };
  byId('logNext').onclick = () => { logPage = Math.min(pageCount - 1, page + 1); renderLogs(); };
}
async function loadLogs() {
  if (loadingLogs) return;
  loadingLogs = true;
  const select = byId('logRun'), id = select.value;
  try {
    const result = await api('logs' + (id ? '?id=' + encodeURIComponent(id) : ''));
    if (select.value !== id) return;
    logsData = result;
    const first = make('option', '最新任务'); first.value = '';
    select.replaceChildren(first);
    for (const run of result.runs) {
      const option = make('option', `${new Date(run.startedAt).toLocaleString()} · ${stateLabels[run.status] || run.status} · ${logTriggers[run.trigger] || run.trigger}`);
      option.value = run.id;
      select.append(option);
    }
    select.value = id;
    if (select.selectedIndex < 0) select.value = '';
    renderLogs();
  } catch (error) { byId('logNotice').textContent = '日志读取失败：' + error.message; }
  finally { loadingLogs = false; }
}
byId('logRun').onchange = () => { logPage = null; void loadLogs(); };
byId('logLevel').onchange = () => { logPage = null; renderLogs(); };
byId('refreshLogs').onclick = loadLogs;
byId('logLatest').onclick = () => { logPage = null; renderLogs(); };
byId('openLogs').onclick = () => { byId('logRun').value = ''; logPage = null; showTab('logsPanel'); };
byId('copyLogs').onclick = async () => {
  const run = logsData?.selected;
  if (!run) return;
  try {
    await navigator.clipboard.writeText(byId('logSummary').textContent + '\n' + logLines(run));
    byId('logNotice').textContent = '本次日志已复制。';
  } catch { byId('logNotice').textContent = '无法访问剪贴板，请选中页面中的日志后手动复制。'; }
};
function showTab(tab) {
  const secondary = {memoryMap:['library','mapDrawer'],usagePanel:['library','usageDrawer'],reviewPanel:['runPanel','reviewDrawer'],logsPanel:['runPanel','logsDrawer']};
  const requested = tab;
  const drawer = secondary[tab]?.[1];
  tab = secondary[tab]?.[0] || tab;
  for (const button of tabs) {
    if (button.dataset.tab === tab) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
  for (const panel of document.querySelectorAll('.tab')) panel.hidden = panel.id !== tab;
  if (drawer) { byId(drawer).open = true; byId(drawer).scrollIntoView({block:'start',behavior:'smooth'}); }
  if (requested === 'memoryMap') displayMap();
  if (requested === 'logsPanel') void loadLogs();
  if (tab === 'settings') {
    refresh().catch(fail);
    void loadDreamModels();
  }
  if (tab === 'runPanel') loadReview().catch(fail);
  if (requested === 'usagePanel') loadUsage().catch(fail);
  if (tab === 'runPanel') {
    api('model').then(displayRunModel).catch(() => { byId('runModel').textContent = '暂时无法读取梦境模型设置。'; });
  }
}
for (const button of tabs) button.onclick = () => showTab(button.dataset.tab);
byId('quickRun').onclick = () => {
  openSessionPicker();
};
byId('quickSearch').onclick = () => byId('q').focus();
byId('copyPrompt').onclick = async () => {
  const example = byId('promptExample');
  const status = byId('copyStatus');
  try {
    await navigator.clipboard.writeText(example.value);
    status.textContent = '已复制。回到对话，粘贴并替换「项目名或问题」。';
  } catch {
    example.focus();
    example.select();
    // The desktop iframe may restrict the asynchronous clipboard API.
    const copied = document.execCommand('copy');
    status.textContent = copied ? '已复制。回到对话后粘贴即可。' : '已选中示例，请按 ⌘C 或 Ctrl+C 复制。';
  }
  status.hidden = false;
};
byId('q').oninput = displayList;
byId('mapSearch').oninput = displayMap;
byId('edit').onclick = () => {
  editing = true;
  byId('content').value = selected.content;
  displayNote();
  byId('content').focus();
};
byId('discard').onclick = () => {
  if (mayDiscard()) { editing = false; displayNote(); }
};
byId('save').onclick = () => perform(byId('save'), async () => {
  selected = await api('note', { action: 'save', name: selected.name, revision: selected.revision, content: byId('content').value });
  editing = false;
  await refresh();
  displayNote();
  show('已保存为新版本。');
});
byId('delete').onclick = () => perform(byId('delete'), async () => {
  if (!confirm('从当前记忆库移除此条目？历史版本仍可查看。')) return;
  await api('note', { action: 'delete', name: selected.name, revision: selected.revision, confirm: true });
  clearNote();
  await refresh();
  show('已移除条目。');
});
function desktopDirectoryPicker() {
  // The workbench is a same-origin iframe. The desktop shell owns the native dialog.
  try { return window.parent.__DSH_DIRECTORY_PICKER__; }
  catch { return undefined; }
}
const directoryPicker = desktopDirectoryPicker();
const choosePath = byId('choosePath');
if (typeof directoryPicker?.pick === 'function') {
  choosePath.hidden = false;
  choosePath.onclick = () => perform(choosePath, async () => {
    const path = await directoryPicker.pick();
    if (typeof path === 'string' && path) {
      byId('newPath').value = path;
      byId('savePath').focus();
    }
  });
}
byId('pathForm').onsubmit = event => {
  event.preventDefault();
  perform(byId('savePath'), async () => {
    if (!mayDiscard()) return;
    const result = await api('settings', { memoryDir: byId('newPath').value.trim() });
    clearNote();
    await refresh({ settings: true });
    show(result.warning || '已保存存储位置。');
  });
};
const dateRange = byId('dateRange');
const since = byId('since');
const until = byId('until');
const runMode = byId('runMode');
const sessionSearch = byId('sessionSearch');
const dateLabel = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const sessionPageSize = 40;
let presets;
let sessions, chosenSession, requestedSession, loadingSessions = false, starting = false;
let sessionLimit = sessionPageSize;

function updateRunButton() {
  byId('run').disabled = starting || lastJob?.status === 'running' || (runMode.value === 'single' && !chosenSession);
}

function renderSessions() {
  const results = byId('sessionResults');
  const status = byId('sessionListStatus');
  const more = byId('moreSessions');
  results.replaceChildren();
  more.hidden = true;
  if (!sessions) {
    status.textContent = loadingSessions ? '正在读取会话列表…' : '会话列表暂不可用，请刷新重试。';
    return;
  }
  const keywords = sessionSearch.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matches = sessions.filter(session => {
    const text = [session.title, session.workspace, session.id].join(' ').toLowerCase();
    return keywords.every(keyword => text.includes(keyword));
  });
  status.textContent = matches.length ? '找到 ' + matches.length + ' 条会话。' : '没有匹配的会话。';
  for (const session of matches.slice(0, sessionLimit)) {
    const button = make('button', '', 'note');
    button.type = 'button';
    button.dataset.sessionId = session.id;
    button.setAttribute('aria-pressed', String(session.id === chosenSession?.id));
    const date = Number.isFinite(session.updatedAt) ? dateLabel.format(session.updatedAt) : '';
    const details = [session.workspace, date].filter(Boolean).join(' · ') || session.id;
    button.append(make('strong', session.title), make('small', details));
    button.onclick = () => selectSession(session);
    results.append(button);
  }
  more.hidden = matches.length <= sessionLimit;
}

function selectSession(session) {
  chosenSession = session;
  byId('sessionSelection').textContent = session ? '已选会话 · ' + session.title : '请选择一个已完成的会话。';
  for (const button of byId('sessionResults').children) {
    button.setAttribute('aria-pressed', String(button.dataset.sessionId === session?.id));
  }
  updateRunButton();
}

async function loadSessions() {
  if (loadingSessions) return;
  loadingSessions = true;
  byId('reloadSessions').disabled = true;
  renderSessions();
  try {
    const { sessions: catalog } = await api('sessions');
    sessions = catalog;
    const id = requestedSession || chosenSession?.id;
    selectSession(sessions.find(session => session.id === id));
    if (id && !chosenSession) show('找不到该会话，请在列表中重新选择。', true);
    requestedSession = null;
  } catch (error) {
    fail(error);
  } finally {
    loadingSessions = false;
    byId('reloadSessions').disabled = false;
    renderSessions();
  }
}

function changeRunMode() {
  const single = runMode.value === 'single';
  byId('sessionPicker').hidden = !single;
  byId('batchControls').hidden = single;
  byId('maxSessions').disabled = single;
  byId('run').textContent = single ? '整理所选会话' : '开始梦境';
  updateRunButton();
  if (single && !sessions) void loadSessions();
}

function openSessionPicker(sessionId) {
  requestedSession = sessionId;
  runMode.value = 'single';
  showTab('runPanel');
  changeRunMode();
  sessionSearch.focus();
}
runMode.onchange = changeRunMode;
sessionSearch.oninput = () => {
  sessionLimit = sessionPageSize;
  renderSessions();
};
sessionSearch.onkeydown = event => {
  if (event.key === 'Enter') event.preventDefault();
};
byId('reloadSessions').onclick = loadSessions;
byId('moreSessions').onclick = () => { sessionLimit += sessionPageSize; renderSessions(); };

function applyDatePreset() {
  const preset = presets?.[dateRange.value];
  if (!preset) return;
  since.value = preset.since;
  until.value = preset.until;
}
dateRange.onchange = applyDatePreset;
since.oninput = until.oninput = () => { dateRange.value = 'custom'; };
api('session-dates').then(result => {
  presets = result;
  dateRange.disabled = false;
  applyDatePreset();
}).catch(fail);
byId('runForm').onsubmit = async event => {
  event.preventDefault();
  const single = runMode.value === 'single';
  if (starting || lastJob?.status === 'running' || (single && !chosenSession)) return;
  const bounds = single || dateRange.value === 'all' ? {} : {
    since: since.value || undefined, until: until.value || undefined,
  };
  if (bounds.since && bounds.until && bounds.since > bounds.until) {
    show('起始日期不能晚于结束日期。', true);
    return;
  }
  starting = true;
  updateRunButton();
  try {
    lastJob = await api('start', {
      ...(single ? { sessionId: chosenSession.id } : { ...bounds, maxSessions: byId('maxSessions').valueAsNumber }),
      force: byId('force').checked,
    });
    show('');
    await poll();
  } catch (error) { fail(error); }
  finally {
    starting = false;
    updateRunButton();
  }
};
byId('cancel').onclick = () => perform(byId('cancel'), () => api('cancel', {})).then(() => poll().catch(fail));
byId('scheduleForm').onsubmit = event => {
  event.preventDefault();
  perform(event.submitter, async () => {
    await api('schedule', { enabled: byId('scheduleEnabled').checked, time: byId('scheduleTime').value });
    show('已保存自动整理计划。');
  });
};
window.addEventListener('beforeunload', event => { if (dirty()) { event.preventDefault(); event.returnValue = ''; } });
api('schedule').then(schedule => {
  byId('scheduleEnabled').checked = schedule.enabled;
  byId('scheduleTime').value = schedule.time;
}).catch(fail);

async function monitor() {
  try { await poll(); } catch (error) { fail(error); }
  if (!byId('runPanel').hidden && byId('logsDrawer').open) await loadLogs();
  if (!byId('library').hidden && byId('usageDrawer').open) await loadUsage().catch(fail);
  setTimeout(monitor, lastJob?.status === 'running' ? 1200 : 4500);
}
initializeGovernance().catch(fail).finally(()=>monitor());


function displayChanges(container, changes) {
  container.replaceChildren();
  if (!changes?.length) { container.append(make('p','没有主题文件变化。','muted')); return; }
  const labels = {added:'新增',modified:'修改',removed:'移除／合并'};
  for (const change of changes) {
    const details = make('details','','change-card');
    const summary = make('summary');
    const title = (change.after || change.before).match(/^# (.+)$/m)?.[1] || change.slug;
    summary.append(make('span',labels[change.kind],'badge change-'+change.kind),make('strong',title),make('small',change.slug));
    const columns = make('div','','diff-columns');
    for (const [label,text] of [['之前',change.before],['之后',change.after]]) {
      const column = make('section');
      const pre = make('pre');
      const otherLines = new Set((label === '之前' ? change.after : change.before).split('\n'));
      for (const line of (text || '（不存在）').split('\n')) {
        const span = make('span',line+'\n',line && !otherLines.has(line) ? (label === '之前' ? 'diff-removed' : 'diff-added') : '');
        pre.append(span);
      }
      column.append(make('h3',label),pre); columns.append(column);
    }
    details.append(summary,columns); container.append(details);
  }
}
function displayPublished(report) {
  byId('publishedSummary').textContent = report?.actualChanges ? `版本 ${report.version} · 根据最终文件内容计算，包含冲突处理结果` : '该版本没有保存变化清单。新确认发布的版本会记录。';
  displayChanges(byId('publishedChanges'),report?.actualChanges);
}
async function loadReview() {
  const epoch = scopeEpoch;
  const result = await api('review');
  if (epoch !== scopeEpoch) return;
  byId('pendingNotice').hidden = !result.draft;
  if (review?.id === result.draft?.id && review) return;
  review = result.draft;
  byId('publishDraft').hidden = byId('discardDraft').hidden = !review;
  byId('conflictList').replaceChildren();
  displayChanges(byId('changeList'),review?.changes);
  if (!review) { byId('reviewSummary').textContent = '没有待审核草稿。整理历史会话后，先在这里核对，再确认发布。'; return; }
  const count = kind=>review.changes.filter(c=>c.kind === kind).length;
  byId('reviewSummary').textContent = `新增 ${count('added')} · 修改 ${count('modified')} · 移除／合并 ${count('removed')} · 疑似冲突 ${review.conflicts.length}。尚未发布。`;
  for (const failed of review.report.failures ?? []) byId('conflictList').append(make('p',`分析失败：${failed.input} · ${failed.reason}`,'uncertain-fact'));
  for (const conflict of review.conflicts) {
    const card = make('section','','conflict-card');
    card.append(make('h3','需要你决定 · '+conflict.slug),make('p','旧：'+conflict.oldFact),make('p','新：'+conflict.newFact),make('p','判断依据：'+conflict.reason,'muted'));
    const label = make('label','处理方式'); const select = make('select'); select.dataset.conflict = conflict.id;
    for (const [value,text] of [['','请选择'],['replace','采用新事实，标记旧事实已被替代'],['keep-old','保留旧事实，不收录这条新事实'],['uncertain','暂不判断，两条均标为待核实']]) {
      const option = make('option',text); option.value = value; select.append(option);
    }
    label.append(select); card.append(label); byId('conflictList').append(card);
  }
}
byId('refreshReview').onclick = ()=>{ review = null; loadReview().catch(fail); };
byId('pendingNotice').onclick = ()=>showTab('reviewPanel');
byId('publishDraft').onclick = ()=>perform(byId('publishDraft'),async()=>{
  if (!review) return;
  const decisions = Object.fromEntries([...document.querySelectorAll('[data-conflict]')].map(select=>[select.dataset.conflict,select.value]));
  if (Object.values(decisions).some(value=>!value)) throw Error('请先为每项疑似冲突选择处理方式。');
  const result = await api('review',{id:review.id,action:'publish',confirm:true,decisions});
  review = null; await loadReview(); await refresh(); await poll();
  displayPublished(result); show('已确认发布。新记忆现在可供对话读取。');
});
byId('discardDraft').onclick = ()=>perform(byId('discardDraft'),async()=>{
  if (!review || !confirm('放弃这份草稿？已发布的记忆保持不变。')) return;
  await api('review',{id:review.id,action:'discard'}); review = null; await loadReview(); await poll(); show('已放弃草稿。');
});
async function switchScope(scope) {
  if (!mayDiscard()) { byId('scopeSelect').value = currentScope; return; }
  show('');
  currentScope = scope; scopeEpoch++; review = null; lastJob = null; store = null; clearNote();
  byId('scopeSelect').value = scope;
  byId('scopeHint').textContent = scope ? `当前项目：${scope}。整理与读取仅使用这个项目的记忆。` : '共享记忆包含原有内容。批量整理会跨项目，请按需选择项目范围。';
  await refresh(); await loadReview(); await loadUsage();
  const dates = await api('session-dates'); presets = dates; applyDatePreset();
  displayPublished(null);
}
byId('scopeSelect').onchange = ()=>switchScope(byId('scopeSelect').value).catch(fail);
byId('goLibrary').onclick = ()=>showTab('library');
byId('useSession').onchange = async()=>{
  targetSession = byId('useSession').value;
  displayNote();
  await loadUsage().catch(fail);
};
async function loadUsage() {
  const epoch = scopeEpoch, session = targetSession;
  const result = await api('usage'+(session ? '?session='+encodeURIComponent(session) : ''));
  if (epoch !== scopeEpoch || session !== targetSession) return;
  const target = session ? '此对话' : (currentScope ? '本项目默认' : '共享默认');
  byId('bindingStatus').textContent = result.binding
    ? `${target}已指定「${result.binding.title}」· ${result.binding.version}。下一条消息提供查阅入口；正文按需读取，引用版本固定，更新后可重新指定。${result.binding.scope === currentScope && store?.version !== result.binding.version ? ' 当前库已有其他版本。' : ''}`
    : result.defaultBinding ? `${target}未单独指定；会沿用${result.defaultBinding.scope ? '项目' : '共享'}默认主题「${result.defaultBinding.title}」。也可通过目录读取其他记忆。`
    : `${target}未指定主题。新对话已可通过目录按需读取；想优先查阅某个主题，可在下方记忆库将它设为默认。`;
  byId('clearBinding').disabled = !result.binding;
  const list = byId('usageList'); list.replaceChildren();
  for (const entry of result.entries.slice(0,50)) {
    const row = make('div','','usage-row');
    row.append(make('strong',entry.kind === 'context' ? '旧版节选交付记录' : '工具已读取'),make('p',`${entry.slug} · ${entry.chars} 字符${entry.truncated ? ' · 节选' : ''}`),make('small',`${new Date(entry.at).toLocaleString()} · ${entry.sessionId || '未知对话'} · ${entry.version || '原始版本'}`));
    list.append(row);
  }
  if (!result.entries.length) list.append(make('p','此范围暂无读取记录。新对话发送消息后，可在这里查看主题读取情况。目录提示本身不算已读取主题。','muted'));
}
byId('refreshUsage').onclick = ()=>loadUsage().catch(fail);
byId('clearBinding').onclick = ()=>perform(byId('clearBinding'),async()=>{await api('use',{target:targetSession ? 'session' : 'default',sessionId:targetSession,clear:true});await loadUsage();});
byId('useMemory').onclick = ()=>perform(byId('useMemory'),async()=>{
  if (!selected) return;
  await api('use',{target:targetSession ? 'session' : 'default',sessionId:targetSession,slug:selected.name,version:store.version});
  showTab('usagePanel'); await loadUsage(); show(targetSession ? '已指定优先查阅主题。下一条消息提供入口，助手按需读取正文。' : '已设为默认参考。新对话首条消息即可看到入口，正文按需读取。');
});
byId('copyReference').onclick = ()=>perform(byId('copyReference'),async()=>{
  const text = `请先调用 dreaming_memory 读取主题 ${selected.name}，scope=${JSON.stringify(currentScope || 'shared')}，version=${JSON.stringify(store.version || '')}，核对日期和已被替代／待核实标记，再结合我的问题回答。`;
  try { await navigator.clipboard.writeText(text); }
  catch { const area = make('textarea'); area.value=text; document.body.append(area); area.select(); const ok=document.execCommand('copy'); area.remove(); if(!ok) throw Error('无法访问剪贴板，请使用页面上的对话示例。'); }
  show('已复制主题引用指令，可粘贴到任意对话。');
});
async function reloadUseSessions() {
  const catalog = await api('sessions');
  const current = targetSession;
  const select = byId('useSession');
  select.replaceChildren();
  const first = make('option','默认参考（含空白新对话）'); first.value=''; select.append(first);
  for (const session of catalog.sessions) {
    const option=make('option',`${session.title} · ${session.workspace || '无项目'}`);option.value=session.id;select.append(option);
    if(session.scope && ![...byId('scopeSelect').options].some(o=>o.value===session.scope)) {
      const scopeOption=make('option',session.scope);scopeOption.value=session.scope;byId('scopeSelect').append(scopeOption);
    }
  }
  targetSession=catalog.sessions.some(s=>s.id===current) ? current : '';
  select.value=targetSession;displayNote();
  return catalog;
}
byId('reloadUseSessions').onclick=()=>perform(byId('reloadUseSessions'),async()=>{await reloadUseSessions();await loadUsage();});
byId('usageDrawer').ontoggle=()=>{if(byId('usageDrawer').open)loadUsage().catch(fail);};
byId('mapDrawer').ontoggle=()=>{if(byId('mapDrawer').open)displayMap();};
byId('reviewDrawer').ontoggle=()=>{if(byId('reviewDrawer').open)loadReview().catch(fail);};
byId('logsDrawer').ontoggle=()=>{if(byId('logsDrawer').open)loadLogs().catch(fail);};
async function initializeGovernance() {
  let catalog;
  try { catalog = await reloadUseSessions(); }
  catch { catalog={sessions:[]}; show('历史会话列表暂不可用，仍可浏览记忆或设置新对话默认主题。'); }
  const params=new URLSearchParams(location.search), session=params.get('session');
  const found=catalog.sessions.find(s=>s.id===session);
  if(found) {targetSession=session;byId('useSession').value=session;}
  await switchScope(found?.scope || '');
  byId('newPath').value = store?.configuredDir || '';
  if(session && params.get('mode') !== 'use') openSessionPicker(session);
  else if(session) {
    showTab('usagePanel');
    if(!found) show('这是尚未保存的新对话。可直接设置默认主题，或复制主题引用指令到对话中使用。');
  }
}
