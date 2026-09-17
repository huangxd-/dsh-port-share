// dsh-port-share Web RPC（设置页 UI ⇄ Host 的端口共享通道）
//
// wire 协议与 DSH 官方 @deepseek-ai/dsh-client-connection 的 rpc 通道逐字节兼容
// （见其 lib/index.js 的 rpcFetchHandler / bridge / register）：
//   - 客户端（settings 设置页）`ctx.connection.rpc.call(channel, endpoint, payload)`
//     POST `${channel}/${endpoint}`，body 为 { type:'client-request', rpcId, method, payload }；
//   - 服务端回 `{ type:'server-response', rpcId, result }`，
//     result 为 { ok:true, value } 或 { ok:false, error:{ code, message, details } }。
//
// 注册路径（与 dsh-pocket 同思路，本文件为独立实现）：
//   1. 首选：动态 inject ['connection','webServer']，把 prefix 路由挂到自己持有的
//      webServer 上，请求先过 connection.requestRejection（401/403 完整栅栏）；
//   2. 旧版 DSH / headless（无 webServer）→ 回退 ctx.connection.rpc.handle。
//
// 本插件对 connection/webServer 都是**可选依赖**（工具功能不依赖它们），
// 所以不用顶层 inject 阻塞插件启动，而是 ctx.inject 动态等待服务就绪。

const PORT_SHARE_RPC_CHANNEL = '/dsh-port-share';

const ENDPOINTS = Object.freeze({
  list: 'list',
  status: 'status',
  add: 'add',
  update: 'update',
  remove: 'remove',
});

/** RPC 请求体上限：4 MB（本插件的载荷都是小控制 JSON，足够）。 */
const RPC_BODY_MAX = 4 * 1024 * 1024;

/** endpoint 段字符（与 dsh-client-connection 的 ENDPOINT_SEGMENT_PATTERN 对齐）。 */
const ENDPOINT_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/;

/** client-request 信封校验失败时使用的兜底 rpcId（与 dsh 内部 INVALID_REQUEST_RPC_ID 对齐）。 */
const INVALID_REQUEST_RPC_ID = 'invalid-request';

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1']);

/**
 * 从 `${channel}/<endpoint>` 路径里取出 endpoint，段非法时返回 undefined。
 * 与 dsh-client-connection 的 endpointFromPath 行为一致。
 */
function endpointFromPath(channel, pathname) {
  if (!pathname.startsWith(`${channel}/`)) return undefined;
  const endpoint = pathname.slice(channel.length + 1);
  if (endpoint.split('/').some((seg) => seg === '' || seg === '.' || seg === '..' || !ENDPOINT_SEGMENT_PATTERN.test(seg))) {
    return undefined;
  }
  return endpoint;
}

/** 构造 server-response JSON（与 dsh-client-connection 的 fullResponse 对齐）。 */
function jsonResponse(rpcId, result) {
  return Response.json({ type: 'server-response', rpcId, result });
}

/**
 * 把 RPC handler 包装成 fetch-shaped handler，逐分支复刻 dsh-client-connection 的
 * rpcFetchHandler：404（非 POST / 无 endpoint）、415（content-type）、400（非 JSON）、
 * gateway/bad-request（信封非法 / method 与 endpoint 不匹配）、500（handler 抛错），
 * 成功返回 server-response JSON（200）。
 */
function rpcFetchHandler(channel, handler, log) {
  return {
    async fetch(request) {
      const endpoint = endpointFromPath(channel, new URL(request.url).pathname);
      if (request.method !== 'POST' || endpoint === undefined) {
        return new Response('not found', { status: 404 });
      }
      const mediaType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
      if (mediaType !== 'application/json') {
        return new Response('content type must be application/json', { status: 415 });
      }
      let body;
      try {
        body = await request.json();
      } catch {
        return new Response('body is not JSON', { status: 400 });
      }
      const rpcId = body && typeof body.rpcId === 'string' ? body.rpcId : INVALID_REQUEST_RPC_ID;
      const method = body && typeof body.method === 'string' ? body.method : null;
      if (rpcId === INVALID_REQUEST_RPC_ID || method === null) {
        return jsonResponse(INVALID_REQUEST_RPC_ID, {
          ok: false,
          error: { code: 'gateway/bad-request', message: 'invalid client-request message', details: { issues: [] } },
        });
      }
      if (method !== endpoint) {
        return jsonResponse(rpcId, {
          ok: false,
          error: {
            code: 'gateway/bad-request',
            message: `method ${JSON.stringify(method)} does not match endpoint ${JSON.stringify(endpoint)}`,
            details: { issues: [] },
          },
        });
      }
      try {
        const result = await handler(endpoint, body.payload, request.signal);
        return jsonResponse(rpcId, result);
      } catch (err) {
        log.error?.('dsh-port-share: rpc %s failed | RPC 失败: %s', endpoint, err?.message ?? err);
        return new Response(`handler failure: ${String(err)}`, { status: 500 });
      }
    },
  };
}

/**
 * node:http 请求 → fetch-shaped handler → node:http 响应的桥接（buffered 模式）。
 * 与 dsh-client-connection 的 bridge 行为一致：
 *   - res.close 时若响应未结束 → abort（client 主动断开不再等 handler）；
 *   - 声明 content-length 超上限 → 413 + 销毁 socket（防无界缓冲）；
 *   - 响应 body 流式回写，遇背压等 drain / close。
 */
async function bridge(req, res, fetchHandler, maxBodyBytes) {
  const abort = new AbortController();
  res.on('close', () => { if (!res.writableEnded) abort.abort(); });

  const declaredLen = req.headers['content-length'];
  if (declaredLen !== undefined && Number(declaredLen) > maxBodyBytes) {
    res.writeHead(413, { connection: 'close' });
    res.end();
    req.destroy();
    return;
  }
  const chunks = [];
  let received = 0;
  for await (const chunk of req) {
    received += chunk.length;
    if (received > maxBodyBytes) {
      res.writeHead(413, { connection: 'close' });
      res.end();
      req.destroy();
      return;
    }
    chunks.push(chunk);
  }

  const url = new URL(req.url ?? '/', 'http://dsh.internal');
  const request = new Request(url, {
    method: req.method ?? 'GET',
    headers: Object.fromEntries(Object.entries(req.headers).filter(([, v]) => typeof v === 'string')),
    ...(chunks.length > 0 ? { body: Buffer.concat(chunks) } : {}),
    signal: abort.signal,
  });

  const response = await fetchHandler.fetch(request);
  const headers = Object.fromEntries(response.headers.entries());
  res.writeHead(response.status, headers);
  if (response.body === null) { res.end(); return; }
  for await (const chunk of response.body) {
    if (!res.write(chunk)) {
      await new Promise((resolve) => {
        const done = () => { res.off('drain', done); res.off('close', done); resolve(); };
        res.once('drain', done);
        res.once('close', done);
      });
    }
    if (res.writableEnded) break;
  }
  res.end();
}

/** 旧版 DSH / 无 connection.requestRejection 时的最小信任栅栏：仅放行 loopback Host。 */
function isTrustedLoopbackRequest(req) {
  const host = req.headers?.host;
  if (!host) return false;
  const hostName = host.split(':')[0];
  if (!LOOPBACK_HOSTNAMES.has(hostName)) return false;
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  try { return new URL(origin).host === host; } catch { return false; }
}

/** 把 webServer.register 的返回值规整成幂等可调用的清理函数。 */
function normalizeDisposer(registered) {
  if (typeof registered === 'function') {
    return () => { try { registered(); } catch { /* 已清理 */ } };
  }
  if (registered && typeof registered.then === 'function') {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      Promise.resolve(registered).then((d) => {
        if (typeof d === 'function') { try { d(); } catch { /* 已清理 */ } }
      }).catch(() => { /* 已清理 */ });
    };
  }
  return () => {};
}

// Cordis contexts expose injected services as properties.  Some test/headless
// hosts additionally provide a string-based get() helper, but that helper is
// not part of the DSH contract and may throw for unknown names.  Prefer the
// injected property and only use get() as a guarded compatibility fallback.
function serviceFromContext(ctx, name) {
  if (ctx && ctx[name] !== undefined) return ctx[name];
  try { return ctx?.get?.(name); } catch { return undefined; }
}

/**
 * 把 /dsh-port-share prefix 路由挂到 webServer 上。返回 disposer（幂等）。
 * 优先用 connection.requestRejection（401/403 完整栅栏）；不可用时退回 loopback 兜底栅栏。
 */
function mountWebRoute(ctx, handler, log) {
  const webServer = serviceFromContext(ctx, 'webServer');
  const connection = serviceFromContext(ctx, 'connection');
  if (!webServer || typeof webServer.register !== 'function') return () => {};

  const fetchHandler = rpcFetchHandler(PORT_SHARE_RPC_CHANNEL, handler, log);
  const route = {
    kind: 'prefix',
    path: PORT_SHARE_RPC_CHANNEL,
    handler: async (req, res) => {
      let rejection;
      // 必须以方法形式调用（内部读 this.trustedHosts / this.browserAuth，见 dsh issue #117）
      if (connection && typeof connection.requestRejection === 'function') {
        try { rejection = connection.requestRejection(req); } catch { rejection = 403; }
      } else if (!isTrustedLoopbackRequest(req)) {
        rejection = 403;
      }
      if (rejection !== undefined) {
        res.writeHead(rejection, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(rejection === 401 ? 'unauthorized' : 'forbidden');
        return;
      }
      await bridge(req, res, fetchHandler, RPC_BODY_MAX);
    },
  };
  return normalizeDisposer(webServer.register(route));
}

function ok(value) {
  return { ok: true, value };
}

function fail(code, message) {
  return { ok: false, error: { code, message, details: { issues: [{ message }] } } };
}

function asPortNumber(v) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
}

/** 只把 UI 需要的字段放到 wire 上（干净的小视图，不带内部结构）。 */
function toView(s) {
  return {
    port: s.port,
    name: s.name ?? '',
    host: s.host ?? '127.0.0.1',
    lan: !!s.lan,
    public: !!s.public,
    publicPort: s.publicPort ?? null,
    mode: s.mode ?? null,
    lanPort: s.lanPort ?? null,
    lanIp: s.lanIp ?? null,
    lanUrl: s.lanUrl ?? null,
    tunnelUrl: s.tunnelUrl ?? null,
    targetReachable: s.targetReachable ?? null,
    proxyRunning: !!s.proxyRunning,
    tunnelRunning: !!s.tunnelRunning,
    tunnelPhase: s.tunnelPhase ?? null,
    error: s.error ?? null,
    tunnelError: s.tunnelError ?? null,
    updatedAt: s.updatedAt ?? null,
  };
}

/** endpoint 分发表：全部走到 manager，异常统一 fail('bad-request', message)。 */
function createRpcHandler(manager, log) {
  return async (endpoint, payload = {}, signal) => {
    if (signal?.aborted) return fail('cancelled', 'The request was cancelled.');
    try {
      switch (endpoint) {
        case ENDPOINTS.list: {
          return ok({ items: manager.list().map(toView) });
        }
        case ENDPOINTS.status: {
          const port = asPortNumber(payload?.port);
          if (port === null) return fail('bad-request', '缺少合法的 port（1-65535）| missing valid port');
          return ok({ item: toView(manager.status(port)) });
        }
        case ENDPOINTS.add: {
          const p = payload ?? {};
          const input = {};
          if (p.port !== undefined) input.port = p.port;
          if (p.host !== undefined) input.host = String(p.host);
          if (p.name !== undefined) input.name = String(p.name);
          if (p.lan !== undefined) input.lan = !!p.lan;
          if (p.public !== undefined) input.public = !!p.public;
          if (p.publicPort !== undefined) input.publicPort = p.publicPort === '' ? null : p.publicPort;
          return ok({ item: toView(await manager.add(input)) });
        }
        case ENDPOINTS.update: {
          const p = payload ?? {};
          const input = { port: p.port };
          if (p.lan !== undefined) input.lan = !!p.lan;
          if (p.public !== undefined) input.public = !!p.public;
          if (p.name !== undefined) input.name = String(p.name);
          if (p.publicPort !== undefined) input.publicPort = p.publicPort === '' ? null : p.publicPort;
          return ok({ item: toView(await manager.update(input)) });
        }
        case ENDPOINTS.remove: {
          const port = asPortNumber(payload?.port);
          if (port === null) return fail('bad-request', '缺少合法的 port（1-65535）| missing valid port');
          return ok(await manager.remove(port));
        }
        default:
          return fail('bad-request', `Unknown endpoint: ${endpoint}`);
      }
    } catch (err) {
      log.error?.('dsh-port-share: rpc %s failed | RPC 失败: %s', endpoint, err?.message ?? err);
      return fail('bad-request', err?.message ?? String(err));
    }
  };
}

/**
 * 注册 /dsh-port-share 逻辑通道（仅本机 loopback 可达）。
 * 首选动态 inject ['connection','webServer'] 挂 prefix 路由；不可用时回退
 * ctx.connection.rpc.handle（旧版 DSH / headless 兼容）。返回 disposer。
 */
export function mountPortShareRpc(ctx, { manager, log = console } = {}) {
  const handler = createRpcHandler(manager, log);

  if (typeof ctx?.inject === 'function') {
    ctx.inject(['connection', 'webServer'], (engineCtx) => {
      engineCtx.effect(() => mountWebRoute(engineCtx, handler, log), 'dsh-port-share: rpc channel');
    });
    return () => {};
  }

  // 没有 ctx.inject 的极简宿主：同步尝试挂载
  const webServer = serviceFromContext(ctx, 'webServer');
  if (webServer && typeof webServer.register === 'function') {
    return ctx.effect(() => mountWebRoute(ctx, handler, log), 'dsh-port-share: rpc channel');
  }
  const connection = serviceFromContext(ctx, 'connection');
  if (connection?.rpc?.handle) {
    return ctx.effect(() => connection.rpc.handle(PORT_SHARE_RPC_CHANNEL, handler, { authority: 'loopback' }), 'dsh-port-share: rpc channel');
  }
  log.warn?.('dsh-port-share: connection/webServer RPC 不可用，设置页 UI 将不显示');
  return () => {};
}

export { PORT_SHARE_RPC_CHANNEL, ENDPOINTS, rpcFetchHandler, bridge, endpointFromPath, createRpcHandler, toView, asPortNumber };
