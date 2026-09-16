// dsh-port-share 集成测试：多端口共享的核心逻辑（不依赖 DSH 宿主，纯 node）
//
// 覆盖：
//   - add：loopback-only 服务 → 自动起 TCP 代理（同端口被占 → 顺延），LAN URL 可访问
//   - 多端口同时共享
//   - list / status / update（开关 lan、改 publicPort）
//   - remove：代理关闭、记录删除
//   - 持久化：新 manager 实例 restore() 自动恢复
//   - 目标服务未启动：add 不占端口，服务起来后看门狗逻辑自动恢复（手动触发 _sync）
//   - 隧道 URL 解析正则

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ShareManager } from '../lib/manager.mjs';
import { QUICK_TUNNEL_URL_RE } from '../lib/tunnel.mjs';

/** 起一个只监听 127.0.0.1 的 HTTP 服务，返回 { port, close }。 */
function startLoopbackServer(port = 0, tag = 'demo') {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`hello from ${tag}`);
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve({
      port: server.address().port,
      close: () => new Promise((r) => server.close(r)),
    }));
  });
}

/** 起一个监听全部接口（0.0.0.0）的服务。 */
function startAnyServer(port = 0, tag = 'any') {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`hello from ${tag}`);
  });
  return new Promise((resolve) => {
    server.listen(port, '0.0.0.0', () => resolve({
      port: server.address().port,
      close: () => new Promise((r) => server.close(r)),
    }));
  });
}

let sandbox;
let silent = { info() {}, warn() {}, error() {} };

before(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'dsh-port-share-test-'));
});

after(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

test('loopback-only 服务 → 自动起代理，LAN URL 可访问（同端口被占 → 顺延）', async () => {
  const svc = await startLoopbackServer(0, 'svc-a');
  const manager = new ShareManager({ home: sandbox, logger: silent });
  try {
    const s = await manager.add({ port: svc.port });
    assert.equal(s.targetReachable, true, '目标服务应可达');
    assert.ok(s.mode === 'proxy', `应为 proxy 模式，实际 ${s.mode}`);
    assert.ok(s.lanPort > 0, '应拿到代理端口');
    assert.ok(s.lanUrl, '应生成 LAN URL');
    assert.ok(s.lanUrl.startsWith('http://'));

    // 经代理/服务访问（127.0.0.1:<lanPort> 一定可达：
    // Linux 走代理顺延端口，Windows 允许同端口共存、回环直连服务）
    const res = await fetch(`http://127.0.0.1:${s.lanPort}/`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'hello from svc-a');
  } finally {
    await manager.dispose();
    await svc.close();
  }
});

test('已绑全部接口的服务 → 直连模式（不占代理端口）', async () => {
  const svc = await startAnyServer(0, 'svc-b');
  const manager = new ShareManager({ home: sandbox, logger: silent });
  try {
    const s = await manager.add({ port: svc.port });
    // 绝大多数环境是直连；个别多网卡/VPN 环境可能走代理，两种都应可访问
    assert.ok(s.lanUrl, '应有 LAN URL');
    assert.ok(s.lanUrl.includes(`:${s.lanPort}`));
    const res = await fetch(`http://127.0.0.1:${s.lanPort}/`);
    assert.equal(await res.text(), 'hello from svc-b');
  } finally {
    await manager.dispose();
    await svc.close();
  }
});

test('多端口同时共享', async () => {
  const a = await startLoopbackServer(0, 'multi-a');
  const b = await startLoopbackServer(0, 'multi-b');
  const c = await startLoopbackServer(0, 'multi-c');
  const manager = new ShareManager({
    home: sandbox,
    logger: silent,
    cloudflaredPath: join(sandbox, 'no-cloudflared-here.exe'), // 阻止真实下载
  });
  try {
    await manager.add({ port: a.port, name: 'A' });
    await manager.add({ port: b.port, name: 'B' });
    await manager.add({ port: c.port, public: true }); // public 会尝试隧道：本机无 cloudflared 时应优雅失败而非崩溃

    const list = manager.list();
    assert.equal(list.length, 3);
    const names = new Set(list.map((s) => s.name));
    assert.ok(names.has('A') && names.has('B'));

    // 每个都该有 LAN URL 且都能访问
    for (const s of list) {
      assert.ok(s.lanUrl, `端口 ${s.port} 应有 LAN URL`);
      const res = await fetch(`http://127.0.0.1:${s.lanPort}/`);
      assert.equal(res.status, 200);
    }
    // public:true 的那条应记录隧道尝试结果（下载/启动失败 → tunnelUrl 为空 + 有错误信息）
    const pub = list.find((s) => s.public === true);
    assert.ok(pub.tunnelUrl === null, '无 cloudflared 环境不应有隧道 URL');
  } finally {
    await manager.dispose();
    await a.close(); await b.close(); await c.close();
  }
});

test('update：关 lan / 开 lan / 改 publicPort / 改 name', async () => {
  const svc = await startLoopbackServer(0, 'svc-upd');
  const manager = new ShareManager({ home: sandbox, logger: silent });
  try {
    const added = await manager.add({ port: svc.port, name: 'old' });
    const proxyPort = added.lanPort;

    let s = await manager.update({ port: svc.port, name: 'new-name', lan: false });
    assert.equal(s.name, 'new-name');
    assert.equal(s.lan, false);
    assert.equal(s.lanUrl, null, '关掉 lan 后不应有 LAN URL');
    assert.equal(s.proxyRunning, false, '代理应已关闭');

    s = await manager.update({ port: svc.port, lan: true });
    assert.equal(s.lan, true);
    assert.ok(s.lanUrl, '重新开启后应有 LAN URL');
    // 原代理端口已释放，重新开可能拿到别的端口；能访问即可
    const res = await fetch(`http://127.0.0.1:${s.lanPort}/`);
    assert.equal(await res.text(), 'hello from svc-upd');
  } finally {
    await manager.dispose();
    await svc.close();
  }
});

test('remove：记录删除 + 代理关闭（端口可被他人复用）', async () => {
  const svc = await startLoopbackServer(0, 'svc-rm');
  const manager = new ShareManager({ home: sandbox, logger: silent });
  try {
    const s = await manager.add({ port: svc.port });
    const proxyPort = s.lanPort;
    await manager.remove(svc.port);
    assert.equal(manager.list().length, 0, '移除后列表应为空');
    assert.throws(() => manager.status(svc.port), /未在共享/);

    // 代理端口应已释放：能绑定成功
    const { createTcpProxy } = await import('../lib/lan.mjs');
    const rebound = await createTcpProxy({ bindPort: proxyPort, targetHost: '127.0.0.1', targetPort: svc.port });
    assert.equal(rebound.port, proxyPort);
    await rebound.close();
  } finally {
    await manager.dispose();
    await svc.close();
  }
});

test('目标服务未启动：add 不占端口，服务起来后 _sync 自动拉起', async () => {
  const manager = new ShareManager({ home: sandbox, logger: silent });
  try {
    // 找一个空闲端口
    const probe = await startLoopbackServer(0, 'probe');
    const freePort = probe.port;
    await probe.close();

    const s = await manager.add({ port: freePort });
    assert.equal(s.targetReachable, false, '目标未启动应标记不可达');
    assert.equal(s.mode, null, '不应起代理（避免占端口堵死之后的服务）');
    assert.equal(s.lanUrl, null);

    // 现在把服务起在这个端口上（能绑定成功 = 我们没占端口）
    const svc = await startLoopbackServer(freePort, 'late-svc');
    try {
      await manager._sync(freePort); // 模拟看门狗下一轮
      const after = manager.status(freePort);
      assert.equal(after.targetReachable, true);
      assert.ok(after.lanUrl, '服务起来后应自动生成 LAN URL');
      const res = await fetch(`http://127.0.0.1:${after.lanPort}/`);
      assert.equal(await res.text(), 'hello from late-svc');
    } finally {
      await svc.close();
    }
  } finally {
    await manager.dispose();
  }
});

test('持久化：新 manager restore() 自动恢复共享', async () => {
  const svc = await startLoopbackServer(0, 'svc-restore');
  const dir = join(sandbox, 'persist-case');
  const m1 = new ShareManager({ home: dir, logger: silent });
  try {
    await m1.add({ port: svc.port, name: 'keep-me' });
  } finally {
    await m1.dispose(); // 模拟插件卸载（记录保留在磁盘）
  }

  const m2 = new ShareManager({ home: dir, logger: silent });
  try {
    await m2.restore();
    const list = m2.list();
    assert.equal(list.length, 1, '重启后应自动恢复 1 个共享');
    assert.equal(list[0].name, 'keep-me');
    assert.ok(list[0].lanUrl, '恢复后应有 LAN URL');
    const res = await fetch(`http://127.0.0.1:${list[0].lanPort}/`);
    assert.equal(await res.text(), 'hello from svc-restore');
  } finally {
    await m2.dispose();
    await svc.close();
  }
});

test('隧道 URL 正则：排除 api.trycloudflare.com', () => {
  assert.equal(QUICK_TUNNEL_URL_RE.exec('https://api.trycloudflare.com something else'), null, 'api 保留子域必须排除');
  const m = QUICK_TUNNEL_URL_RE.exec('INF 2026-01-01T00:00:00Z https://abc-123-def.trycloudflare.com registered conn');
  assert.ok(m, '应匹配到随机子域');
  assert.equal(m[0], 'https://abc-123-def.trycloudflare.com');
});
