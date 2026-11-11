import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const source = await readFile(new URL('./client/client.js', import.meta.url), 'utf8');

function harness() {
  let plugin, states = [], cursor = 0, effects = [], timers = [], registrations = new Map(), layout, menu;
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState(initial) { const i = cursor++; if (!(i in states)) states[i] = initial; return [states[i], next => { states[i] = typeof next === 'function' ? next(states[i]) : next; }]; },
    useRef(initial) { const i = cursor++; return states[i] ||= { current: initial }; },
    useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
    useEffect: fn => effects.push(fn),
  };
  vm.runInNewContext(source, {
    window: { __ModuleLoader__: { load: ({ factory }) => { plugin = factory(id => { assert.equal(id, 'react'); return React; }); } } },
    setTimeout: fn => { timers.push(fn); return timers.length; }, clearTimeout() {},
  });
  const ctx = {
    get(name) { assert.equal(name, 'layout'); return layout; },
    inject(services, apply) {
      assert.equal(services[0], 'contextMenus');
      apply({ effect: activate => activate(), contextMenus: { register: input => { menu = input; } } });
    },
    slots: {
      inject(slot, factory) { const dispose = factory(); assert.equal(typeof dispose, 'function', `${slot} factory must return a disposer, not a generator`); },
      register(meta, component) { registrations.set(meta.name, { meta, component }); return () => registrations.delete(meta.name); },
    },
  };
  plugin.apply(ctx);
  return { plugin, registrations, timers, menu, setLayout: value => { layout = value; },
    render(component, props, fresh = false) { if (fresh) states = []; cursor = 0; return component(props); },
    effects: () => effects.splice(0).map(fn => fn()),
  };
}
function find(tree, type) { if (!tree || typeof tree !== 'object') return; if (tree.type === type) return tree; return tree.children?.map(child => find(child, type)).find(Boolean); }

test('module namespace and slot factories activate actual registrations', () => {
  const h = harness();
  assert.equal(h.plugin.__esModule, true);
  assert.equal(Object.prototype.toString.call(h.plugin), '[object Module]');
  assert.equal(h.registrations.size, 3);
  assert.equal(h.registrations.get('main').meta.key, 'dsh-dreaming');
});
test('sidebar click uses late layout service; panel close returns to conversation', () => {
  const h = harness(), selected = [];
  const Sidebar = h.registrations.get('sidebar.footer.action').component;
  h.setLayout({ selectPanel: key => selected.push(key) });
  find(h.render(Sidebar, { wide: true }), 'button').props.onClick();
  assert.deepEqual(selected, ['dsh-dreaming']);
  const Panel = h.registrations.get('main').component;
  const tree = h.render(Panel, {}, true);
  const cleanups = h.effects();
  find(tree, 'button').props.onClick();
  assert.deepEqual(selected, ['dsh-dreaming', null]);
  assert.equal(find(h.render(Sidebar, {}, true), 'button').props['aria-pressed'], true);
  cleanups.forEach(fn => fn?.());
  assert.equal(find(h.render(Sidebar, {}, true), 'button').props['aria-pressed'], false);
});
test('missing layout reports an error instead of a silent no-op', () => {
  const h = harness(), Sidebar = h.registrations.get('sidebar.footer.action').component;
  find(h.render(Sidebar), 'button').props.onClick();
  const alert = find(h.render(Sidebar), 'p');
  assert.equal(alert.props.role, 'alert');
  assert.match(alert.children[0], /布局服务/);
});
test('the session menu opens Dreaming with the clicked session ID', () => {
  const h = harness(), panels = [];
  h.setLayout({ selectPanel: id => panels.push(id) });
  assert.equal(h.menu.target, 'session');
  h.menu.resolve({ sessionId: 'clicked&id' })[0].run();
  assert.deepEqual(panels, ['dsh-dreaming']);
  const panel = h.render(h.registrations.get('main').component);
  const frame = panel.children.find(child => typeof child?.type === 'function');
  const url = find(h.render(frame.type, frame.props, true), 'iframe').props.src;
  assert.equal(new URL(url, 'https://app.example').searchParams.get('session'), 'clicked&id');
});
test('iframe rejects shell fallback and offers retry; valid manager loads', () => {
  const h = harness(), Frame = h.registrations.get('settings.section').component;
  let tree = h.render(Frame); h.effects();
  find(tree, 'iframe').props.onLoad({ currentTarget: { contentDocument: { getElementById: () => null } } });
  tree = h.render(Frame);
  assert.equal(tree.children[1].props.role, 'alert');
  assert.equal(find(tree, 'iframe').props.style.display, 'none');
  find(tree, 'button').props.onClick();
  tree = h.render(Frame); h.effects();
  assert.equal(find(tree, 'iframe').props.key, 1);
  find(tree, 'iframe').props.onLoad({ currentTarget: { contentDocument: { getElementById: () => ({}) } } });
  tree = h.render(Frame);
  assert.equal(tree.children[0], null); assert.equal(tree.children[1], null);
});
test('iframe timeout produces visible feedback', () => {
  const h = harness(), Frame = h.registrations.get('settings.section').component;
  h.render(Frame); h.effects(); h.timers[0]();
  const tree = h.render(Frame);
  assert.match(tree.children[1].children[0].children[0], /超时/);
});
