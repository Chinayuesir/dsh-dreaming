// The shell owns main-panel selection. A local `open` flag alone cannot mount it.
window.__ModuleLoader__.load({
  id: '@local/dsh-dreaming',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;
    const PANEL_ID = 'dsh-dreaming';
    const buttonStyle = { cursor: 'pointer', border: '1px solid var(--dsw-alias-line, #43524c)', borderRadius: 7, padding: '8px 12px', background: 'transparent', color: 'inherit', whiteSpace: 'nowrap' };

    function apply(ctx) {
      let active = false;
      let launch = null;
      let launchId = 0;
      const listeners = new Set();
      const snapshot = () => active;
      const subscribe = (listener) => { listeners.add(listener); return () => listeners.delete(listener); };
      const notify = () => { for (const listener of listeners) listener(); };
      const setActive = (next) => { active = next; notify(); };
      // Resolve at click time: layout may register after this plugin on cold boot.
      function selectPanel(key) {
        let layout;
        try { layout = ctx.layout; } catch { /* service not registered yet */ }
        if (!layout && typeof ctx.get === 'function') layout = ctx.get('layout');
        if (typeof layout?.selectPanel !== 'function') throw new Error('梦境面板暂时无法打开：桌面布局服务尚未就绪，请重试或重新加载窗口。');
        layout.selectPanel(key);
      }
      function SidebarButton({ wide } = {}) {
        const open = React.useSyncExternalStore(subscribe, snapshot, snapshot);
        const [error, setError] = React.useState('');
        return h('div', { style: { minWidth: 0 } },
          h('button', {
            type: 'button', title: '梦境 · 记忆管理', 'aria-label': '梦境 · 记忆管理', 'aria-pressed': open,
            style: {
              ...buttonStyle, display: 'flex', alignItems: 'center', justifyContent: 'center',
              gap: 6, width: '100%', padding: '7px 9px',
              borderColor: open ? 'currentColor' : 'transparent',
              background: open ? 'color-mix(in srgb, currentColor 8%, transparent)' : 'transparent',
            },
            onClick: () => {
              try {
                if (!open) { launch = null; notify(); }
                selectPanel(open ? null : PANEL_ID);
                setError('');
              } catch (e) { setError(e.message); }
            },
          }, h('span', { 'aria-hidden': true }, '☾'), wide ? '梦境' : null),
          error ? h('p', { role: 'alert', style: { color: '#d96558', fontSize: 12, overflowWrap: 'anywhere' } }, error) : null,
        );
      }
      function ManagerFrame({ launch: target } = {}) {
        const [attempt, setAttempt] = React.useState(0);
        const [state, setState] = React.useState('loading');
        const [error, setError] = React.useState('');
        const loaded = React.useRef(false);
        React.useEffect(() => {
          loaded.current = false;
          setState('loading');
          setError('');
          const timer = setTimeout(() => {
            if (!loaded.current) { setState('error'); setError('记忆管理页加载超时。请确认梦境 Host 插件已启用，然后重试。'); }
          }, 12000);
          return () => clearTimeout(timer);
        }, [attempt, target]);
        function failed(message) { loaded.current = true; setState('error'); setError(message); }
        return h('div', { style: { display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 } },
          state === 'loading' ? h('p', { role: 'status', style: { padding: '0 20px' } }, '正在加载记忆管理…') : null,
          state === 'error' ? h('div', { role: 'alert', style: { padding: 20 } },
            h('p', null, error), h('button', { type: 'button', style: buttonStyle, onClick: () => setAttempt((n) => n + 1) }, '重新加载')) : null,
          h('iframe', {
            key: attempt, src: target ? '/dreaming?session=' + encodeURIComponent(target.sessionId) + '&open=' + target.id + '&mode=' + (target.mode || 'run') : '/dreaming',
            title: '梦境记忆库管理',
            style: { width: '100%', flex: 1, minHeight: 420, border: 0, display: state === 'error' ? 'none' : 'block' },
            onError: () => failed('无法加载 /dreaming。请确认梦境 Host 插件已启用。'),
            onLoad: (event) => {
              try {
                const doc = event.currentTarget.contentDocument;
                // A shell fallback or error document also fires onLoad; it is not success.
                if (!doc?.getElementById('notes') || !doc?.getElementById('content')) {
                  failed('梦境管理路由未返回管理页面。请重新加载桌面端，确认插件已正确安装。'); return;
                }
                loaded.current = true; setState('ready'); setError('');
              } catch (e) { failed(`无法读取梦境管理页：${e.message}`); }
            },
          }),
        );
      }
      function Panel() {
        const [error, setError] = React.useState('');
        const target = React.useSyncExternalStore(subscribe, () => launch);
        React.useEffect(() => { setActive(true); return () => setActive(false); }, []);
        return h('section', { 'aria-label': '梦境管理面板', style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, width: '100%' } },
          h('header', { style: { display: 'flex', alignItems: 'center', gap: 16, padding: '12px 20px' } },
            h('strong', { style: { flex: 1 } }, '梦境 · 配置与记忆管理'),
            h('button', { type: 'button', style: buttonStyle, onClick: () => { try { selectPanel(null); } catch (e) { setError(e.message); } } }, '返回对话')),
          error ? h('p', { role: 'alert' }, error) : null,
          h(ManagerFrame, { launch: target }),
        );
      }
      // Slot injection expects a normal callback returning the registration's disposer.
      // A generator returns an iterator without running the registration body.
      ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
        name: 'sidebar.footer.action', id: PANEL_ID, order: 20, label: () => '梦境',
      }, SidebarButton));
      ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main', key: PANEL_ID, label: () => '梦境',
      }, Panel));
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section', id: PANEL_ID, order: 100, label: () => '梦境记忆库',
      }, ManagerFrame));
      if (typeof ctx.inject === 'function') {
        ctx.inject(['contextMenus'], scope => {
          scope.effect(() => scope.contextMenus.register({
            id: 'session.dsh-dreaming',
            target: 'session',
            order: 400,
            resolve: ({ sessionId }) => typeof sessionId === 'string' ? [{
              id: 'dream',
              label: '梦境：整理此会话',
              run: () => {
                launch = { sessionId, id: ++launchId };
                notify();
                selectPanel(PANEL_ID);
              },
            }, {
              id:'use-memory', label:'梦境：在此会话使用记忆',
              run:()=>{ launch={sessionId,id:++launchId,mode:'use'};notify();selectPanel(PANEL_ID); },
            }] : [],
          }), 'dsh-dreaming: session menu');
        });
      }
    }
    // Match the module namespace returned by the working talk-map bundle.
    const exports = { name: '@local/dsh-dreaming', inject: ['slots'], apply };
    Object.defineProperty(exports, '__esModule', { value: true });
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
    return exports;
  },
});
