// dsh-port-share Web RPC 单元测试：envelope 处理 / endpoint 分发 / node-http 桥接
// 不依赖 DSH 宿主与真实端口（用 fake manager + fake req/res），纯 node 可跑。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createRpcHandler,
  rpcFetchHandler,
  bridge,
  endpointFromPath,
  PORT_SHARE_RPC_CHANNEL,
  toView,
  mountPortShareRpc,
} from '../lib/web-rpc.js';

/** 最小 fake manager：add/update/remove/status/list，行为与 ShareManager 的对外语义一致。 */
function makeManager() {
  let seq = 0;
  const shares = new Map();
  function asPort(v) {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
      throw new Error('端口必须是 1-65535 的整数 | port must be an integer in 1..65535');
    }
    return n;
  }
  function view(rec) {
    return {
      ...rec,
      lanIp: rec.mode ? '192.168.1.5' : null,
      lanUrl: rec.mode ? `http://192.168.1.5:${rec.lanPort}` : null,
      proxyRunning: rec.mode === 'proxy',
      tunnelRunning: !!rec.tunnelUrl,
    };
  }
  return {
    async add(input = {}) {
      const port = asPort(input.port);
      if (shares.has(port)) throw new Error(`端口 ${port} 已经在共享中`);
      const rec = {
        id: 'id' + (++seq),
        port,
        host: String(input.host ?? '127.0.0.1'),
        name: String(input.name ?? '').trim(),
        lan: input.lan !== false,
        public: !!input.public,
        publicPort: input.publicPort === undefined || input.publicPort === null || input.publicPort === '' ? null : asPort(input.publicPort),
        mode: 'proxy',
        lanPort: port,
        tunnelUrl: input.public ? `https://abc-123.trycloudflare.com` : null,
        targetReachable: true,
        error: null,
        tunnelError: null,
        createdAt: 't',
        updatedAt: 't',
      };
      shares.set(port, rec);
      return view(rec);
    },
    async update(input = {}) {
      const port = asPort(input.port);
      const rec = shares.get(port);
      if (!rec) throw new Error(`端口 ${port} 未在共享中 | not shared`);
      if (input.lan !== undefined) rec.lan = !!input.lan;
      if (input.public !== undefined) rec.public = !!input.public;
      if (input.name !== undefined) rec.name = String(input.name ?? '').trim();
      if (input.publicPort !== undefined) rec.publicPort = input.publicPort === null || input.publicPort === '' ? null : asPort(input.publicPort);
      // 与真实 ShareManager 的 _syncInternal 语义一致：公网关闭时清空隧道 URL
      if (rec.public) rec.tunnelUrl = rec.tunnelUrl ?? 'https://abc-123.trycloudflare.com';
      else rec.tunnelUrl = null;
      return view(rec);
    },
    async remove(port) {
      port = asPort(port);
      if (!shares.has(port)) throw new Error(`端口 ${port} 未在共享中 | not shared`);
      shares.delete(port);
      return { removed: true, port };
    },
    status(port) {
      const rec = shares.get(asPort(port));
      if (!rec) throw new Error(`端口 ${port} 未在共享中 | not shared`);
      return view(rec);
    },
    list() {
      return [...shares.values()].map(view);
    },
  };
}

function silentLog() {
  return { info() {}, warn() {}, error() {} };
}

/** 构造一个合法的 client-request 信封。 */
function envelope(endpoint, payload) {
  return { type: 'client-request', rpcId: 'rpc-1', method: endpoint, payload };
}

async function post(handler, pathname, body) {
  const request = new Request(`http://127.0.0.1${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return handler.fetch(request);
}

test('endpointFromPath：合法/非法段', () => {
  assert.equal(endpointFromPath('/dsh-port-share', '/dsh-port-share/list'), 'list');
  assert.equal(endpointFromPath('/dsh-port-share', '/dsh-port-share/a.b-c_$d'), 'a.b-c_$d');
  assert.equal(endpointFromPath('/dsh-port-share', '/dsh-port-share/'), undefined);
  assert.equal(endpointFromPath('/dsh-port-share', '/dsh-port-share/x/y'), 'x/y'); // 多段 endpoint 按协议是合法的
  assert.equal(endpointFromPath('/dsh-port-share', '/dsh-port-share/a b'), undefined); // 含空格 → 非法段
  assert.equal(endpointFromPath('/dsh-port-share', '/other/list'), undefined);
});

test('RPC handler：list / add / update / remove / status 全链路', async () => {
  const handler = createRpcHandler(makeManager(), silentLog());

  // 空列表
  let res = await handler('list', {}, undefined);
  assert.equal(res.ok, true);
  assert.deepEqual(res.value.items, []);

  // add（lan 默认开，public 默认关）
  res = await handler('add', { port: 3000, name: 'demo' }, undefined);
  assert.equal(res.ok, true);
  assert.equal(res.value.item.port, 3000);
  assert.equal(res.value.item.lan, true);
  assert.equal(res.value.item.public, false);
  assert.equal(res.value.item.tunnelUrl, null);

  // add 公网
  res = await handler('add', { port: 8080, public: true }, undefined);
  assert.equal(res.ok, true);
  assert.match(res.value.item.tunnelUrl, /^https:\/\/.*trycloudflare\.com$/);

  // 重复 add → 业务异常转 fail
  res = await handler('add', { port: 3000 }, undefined);
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'bad-request');
  assert.match(res.error.message, /已经在共享中/);

  // list 两条
  res = await handler('list', {}, undefined);
  assert.equal(res.value.items.length, 2);

  // update：关掉 8080 公网
  res = await handler('update', { port: 8080, public: false }, undefined);
  assert.equal(res.ok, true);
  assert.equal(res.value.item.public, false);
  assert.equal(res.value.item.tunnelUrl, null);

  // status
  res = await handler('status', { port: 3000 }, undefined);
  assert.equal(res.ok, true);
  assert.equal(res.value.item.port, 3000);

  // remove
  res = await handler('remove', { port: 3000 }, undefined);
  assert.equal(res.ok, true);
  assert.equal(res.value.removed, true);
  res = await handler('list', {}, undefined);
  assert.equal(res.value.items.length, 1);

  // remove 不存在的 → fail
  res = await handler('remove', { port: 9999 }, undefined);
  assert.equal(res.ok, false);
});

test('RPC handler：参数校验与未知 endpoint', async () => {
  const handler = createRpcHandler(makeManager(), silentLog());

  for (const [ep, payload] of [
    ['add', {}],
    ['add', { port: 0 }],
    ['add', { port: 65536 }],
    ['status', {}],
    ['remove', { port: 'abc' }],
  ]) {
    const res = await handler(ep, payload, undefined);
    assert.equal(res.ok, false, `${ep} ${JSON.stringify(payload)} 应失败`);
    assert.equal(res.error.code, 'bad-request');
    assert.equal(typeof res.error.message, 'string');
  }

  const unknown = await handler('nope', {}, undefined);
  assert.equal(unknown.ok, false);
  assert.match(unknown.error.message, /Unknown endpoint/);

  // 取消信号
  const cancelled = await handler('list', {}, { aborted: true });
  assert.equal(cancelled.ok, false);
  assert.equal(cancelled.error.code, 'cancelled');
});

test('fetch handler：envelope 协议逐分支', async () => {
  const inner = createRpcHandler(makeManager(), silentLog());
  const handler = rpcFetchHandler(PORT_SHARE_RPC_CHANNEL, inner, silentLog());

  // 成功
  let response = await post(handler, '/dsh-port-share/list', envelope('list', {}));
  assert.equal(response.status, 200);
  let json = await response.json();
  assert.equal(json.type, 'server-response');
  assert.equal(json.rpcId, 'rpc-1');
  assert.equal(json.result.ok, true);
  assert.deepEqual(json.result.value.items, []);

  // method 与 endpoint 不匹配
  response = await post(handler, '/dsh-port-share/list', envelope('status', {}));
  assert.equal(response.status, 200);
  json = await response.json();
  assert.equal(json.result.ok, false);
  assert.equal(json.result.error.code, 'gateway/bad-request');
  assert.match(json.result.error.message, /does not match endpoint/);

  // 非法信封（缺 method）
  response = await post(handler, '/dsh-port-share/list', { type: 'client-request', rpcId: 'rpc-1', payload: {} });
  json = await response.json();
  assert.equal(json.result.ok, false);
  assert.equal(json.result.error.code, 'gateway/bad-request');

  // 非 POST → 404
  response = await handler.fetch(new Request('http://127.0.0.1/dsh-port-share/list'));
  assert.equal(response.status, 404);

  // content-type 错误 → 415
  response = await handler.fetch(new Request('http://127.0.0.1/dsh-port-share/list', {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: 'x',
  }));
  assert.equal(response.status, 415);

  // body 非 JSON → 400
  response = await post(handler, '/dsh-port-share/list', '{not json');
  assert.equal(response.status, 400);

  // handler 抛错 → 500（用一个会直接 throw 的 handler 验证 500 分支）
  const throwing = rpcFetchHandler(PORT_SHARE_RPC_CHANNEL, async () => { throw new Error('boom'); }, silentLog());
  response = await post(throwing, '/dsh-port-share/list', envelope('list', {}));
  assert.equal(response.status, 500);
});

test('bridge：node:http 风格请求 → fetch handler → 响应回写', async () => {
  const seen = [];
  const fetchHandler = {
    async fetch(request) {
      seen.push({
        method: request.method,
        url: request.url,
        ct: request.headers.get('content-type'),
        body: await request.text(),
      });
      return Response.json({ type: 'server-response', rpcId: 'rpc-1', result: { ok: true, value: { hello: 1 } } });
    },
  };

  const body = JSON.stringify(envelope('list', {}));
  const req = {
    headers: { host: '127.0.0.1:3080', 'content-type': 'application/json' },
    method: 'POST',
    url: '/dsh-port-share/list',
    destroy() {},
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(body);
    },
  };
  const out = { status: 0, body: '', ended: false };
  const res = {
    writableEnded: false,
    writeHead(s) { out.status = s; },
    end(b) { if (b !== undefined) out.body += Buffer.from(b).toString('utf8'); out.ended = true; res.writableEnded = true; },
    write(b) { out.body += Buffer.from(b).toString('utf8'); return true; },
    once() {},
    off() {},
    on() {},
  };

  await bridge(req, res, fetchHandler, 1024 * 1024);

  assert.equal(out.status, 200);
  assert.equal(out.ended, true);
  const parsed = JSON.parse(out.body);
  assert.equal(parsed.type, 'server-response');
  assert.equal(parsed.result.ok, true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].method, 'POST');
  assert.match(seen[0].url, /\/dsh-port-share\/list$/);
  assert.equal(seen[0].ct, 'application/json');
});

test('bridge：超限 body → 413 且不调用 handler', async () => {
  let called = false;
  const fetchHandler = { async fetch() { called = true; return new Response('x'); } };
  const big = JSON.stringify({ data: 'x'.repeat(2048) });
  const req = {
    headers: { host: '127.0.0.1', 'content-length': String(big.length) },
    method: 'POST',
    url: '/dsh-port-share/list',
    destroy() {},
    async *[Symbol.asyncIterator]() { yield Buffer.from(big); },
  };
  const out = { status: 0, body: '', ended: false, destroyed: false };
  const res = {
    writableEnded: false,
    writeHead(s) { out.status = s; },
    end() { out.ended = true; res.writableEnded = true; },
    write() { return true; },
    once() {},
    off() {},
    on() {},
  };

  await bridge(req, res, fetchHandler, 1024);
  assert.equal(out.status, 413);
  assert.equal(called, false);
});

test('toView：只暴露 UI 字段，不泄露内部结构', () => {
  const view = toView({
    id: 'secret-id',
    port: 3000,
    name: 'demo',
    host: '127.0.0.1',
    lan: true,
    public: true,
    publicPort: 3000,
    mode: 'proxy',
    lanPort: 3001,
    lanIp: '192.168.1.5',
    lanUrl: 'http://192.168.1.5:3001',
    tunnelUrl: 'https://abc.trycloudflare.com',
    targetReachable: true,
    proxyRunning: true,
    tunnelRunning: true,
    tunnelPhase: 'ready',
    error: null,
    tunnelError: null,
    updatedAt: '2026-01-01T00:00:00.000Z',
    internal: { boom: 1 },
  });
  assert.equal(view.port, 3000);
  assert.equal(view.id, undefined);
  assert.equal(view.internal, undefined);
  assert.equal(view.tunnelUrl, 'https://abc.trycloudflare.com');
});

test('mountPortShareRpc：优先 webServer，缺失时回退 connection.rpc.handle', () => {
  const manager = makeManager();
  const effects = [];
  const routes = [];
  const webCtx = {
    connection: {},
    webServer: { register(route) { routes.push(route); return () => {}; } },
    effect(fn) { const d = fn(); effects.push(fn); return d; },
  };
  mountPortShareRpc(webCtx, { manager, log: silentLog() });
  // Minimal hosts without ctx.inject mount synchronously through webServer.
  assert.equal(effects.length, 1);
  assert.equal(routes.length, 1);
  assert.equal(routes[0].kind, 'prefix');
  assert.equal(routes[0].path, PORT_SHARE_RPC_CHANNEL);

  let handled = null;
  const fallback = {
    connection: { rpc: { handle(...args) { handled = args; return () => {}; } } },
    effect(fn) { return fn(); },
  };
  mountPortShareRpc(fallback, { manager, log: silentLog() });
  assert.equal(handled?.[0], PORT_SHARE_RPC_CHANNEL);
  assert.equal(typeof handled?.[1], 'function');
  assert.deepEqual(handled?.[2], { authority: 'loopback' });
});
