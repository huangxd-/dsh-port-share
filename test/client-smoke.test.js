// dsh-port-share 客户端冒烟测试：验证 client/client.js 能按 DSH 模块系统加载，
// 并在 apply() 时正确注册 settings.section 槽位、RPC 调用走 /dsh-port-share 通道。
// 不渲染 React（stub createElement），只验证接线。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const bundlePath = resolve(here, '../client/client.js');

/** 在隔离的 window 环境里加载 client bundle，返回 module.exports（cordis 插件对象）。 */
function loadBundle() {
  let capturedFactory = null;
  const windowStub = {
    __ModuleLoader__: {
      load({ id, factory }) {
        capturedFactory = { id, factory };
      },
    },
  };
  const code = readFileSync(bundlePath, 'utf8');
  // 在 stub window 作用域下执行 bundle（bundle 只引用 window.__ModuleLoader__ 与 require）
  const fn = new Function('window', 'require', code);
  // require stub：只需能解析 'react'（冒烟不渲染，createElement 返回占位节点即可）
  const reactStub = {
    createElement(type, props, ...children) {
      return { type, props: props ?? null, children };
    },
    useEffect() {},
    useState(initial) {
      const box = { value: initial };
      return [box.value, (v) => { box.value = typeof v === 'function' ? v(box.value) : v; }];
    },
    useCallback(fn) { return fn; },
    useRef(initial) { return { current: initial }; },
  };
  fn(windowStub, (id) => {
    if (id === 'react') return reactStub;
    throw new Error(`unexpected require: ${id}`);
  });

  assert.ok(capturedFactory, 'bundle 必须调用 window.__ModuleLoader__.load');
  assert.equal(capturedFactory.id, 'dsh-port-share');

  const moduleBox = { exports: {} };
  const factoryResult = capturedFactory.factory((id) => {
    if (id === 'react') return reactStub;
    throw new Error(`unexpected require: ${id}`);
  });
  return factoryResult ?? moduleBox.exports;
}

test('client bundle：插件对象形状正确', () => {
  const plugin = loadBundle();
  assert.equal(plugin.name, 'dsh-port-share');
  assert.ok(Array.isArray(plugin.inject));
  assert.ok(plugin.inject.includes('connection'));
  assert.ok(plugin.inject.includes('slots'));
  assert.ok(plugin.inject.includes('locale'));
  assert.equal(typeof plugin.apply, 'function');
});

test('client bundle：apply 注册 settings.section 槽位', () => {
  const plugin = loadBundle();

  const registered = [];
  const slotsStub = {
    inject(slotName, factory) {
      assert.equal(slotName, 'settings.section');
      const disposer = factory();
      registered.push(disposer);
      return disposer;
    },
    register(desc, Component) {
      return { desc, Component };
    },
  };
  const ctx = {
    connection: {
      rpc: {
        async call(channel, endpoint, payload) {
          return { ok: true, value: { items: [] } };
        },
      },
    },
    slots: slotsStub,
    locale: undefined, // locale 未就绪/缺失时走 fallbackT
    effect(fn, label) {
      return { fn, label };
    },
  };

  plugin.apply(ctx);

  assert.equal(registered.length, 1);
  const { desc, Component } = registered[0];
  assert.equal(desc.name, 'settings.section');
  assert.equal(desc.id, 'dsh-port-share');
  assert.equal(typeof desc.label, 'function');
  assert.equal(desc.label(), '端口共享'); // 无 locale 服务时走 zh 兜底
  assert.equal(typeof Component, 'function');

  // 槽位注入的 props：rpcCall + t
  const props = desc.inject();
  assert.equal(typeof props.rpcCall, 'function');
  assert.equal(typeof props.t, 'function');
  assert.equal(props.t('add'), '添加共享');

  // rpcCall 走 /dsh-port-share 通道
  let called = null;
  const registered2 = [];
  const ctx2 = {
    connection: { rpc: { async call(...args) { called = args; return { ok: true, value: {} }; } } },
    slots: {
      inject: (_s, f) => { registered2.push(f()); },
      register: (d, C) => ({ desc: d, Component: C }),
    },
    effect() {},
  };
  plugin.apply(ctx2);
  const props2 = registered2[0].desc.inject();
  props2.rpcCall('list', {});
  assert.deepEqual(called, ['/dsh-port-share', 'list', {}, undefined]);
});

test('client bundle：无 connection / slots 时静默退出不抛错', () => {
  const plugin = loadBundle();
  // 无 connection
  plugin.apply({});
  // 无 slots
  plugin.apply({
    connection: { rpc: { call: async () => ({ ok: true }) } },
  });
  // 全空 ctx
  plugin.apply({});
});
