// dsh-port-share 核心：多端口共享管理器
//
// 每个端口一条「共享记录」，两路暴露可独立开关：
//   - lan     局域网：直连（服务已绑全部接口）或通用 TCP 代理（服务只绑 loopback）
//   - public  公网：cloudflared 快速隧道（每端口一个独立子进程 + 独立 trycloudflare URL）
//
// 记录字段语义：
//   - publicPort  用户偏好的局域网监听端口（持久化，null = 自动取本地端口，被占顺延）
//   - lanPort     实际生效的局域网端口（直连时 = 本地端口；代理时 = 代理绑定端口）
//   - mode        'proxy' | 'direct' | null
//
// 状态机（_syncInternal，每次 add/update/开机恢复/看门狗都会跑一遍）：
//   1. 探测目标服务（host:port）是否可达；
//   2. 不可达 → 停掉一切监听，只保留配置，等看门狗重试（防止先占端口、
//      把用户之后才启动的服务堵死）；
//   3. 可达 → 按开关拉起局域网暴露与公网隧道。
// 目标服务崩溃 / 隧道进程死亡 → 看门狗自动恢复（隧道 URL 会变，以 status 为准）。

import { randomUUID } from 'node:crypto';
import { createStore } from './store.mjs';
import { lanIpv4, probeTcp, createTcpProxy } from './lan.mjs';
import { resolveCloudflared, startQuickTunnel } from './tunnel.mjs';

const WATCHDOG_MS = 15_000;        // 看门狗间隔
const TUNNEL_RETRY_MIN_MS = 60_000; // 隧道失败后的最小重试间隔（防打爆下载源）

function asPort(v, label) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`${label ?? '端口'}必须是 1-65535 的整数 | port must be an integer in 1..65535`);
  }
  return n;
}

export class ShareManager {
  /**
   * @param {object} [opts]
   * @param {string} [opts.home]      $DSH_HOME（持久化 + cloudflared 缓存目录）
   * @param {object} [opts.logger]    带 info/warn/error 的对象
   * @param {string} [opts.cloudflaredPath] 用户指定的 cloudflared 二进制路径
   */
  constructor({ home, logger = console, cloudflaredPath = '' } = {}) {
    this.home = home;
    this.logger = logger;
    this.cloudflaredPath = cloudflaredPath || process.env.DSH_PORT_SHARE_CLOUDFLARED || '';
    this.store = createStore({ home });
    /** @type {Map<number, object>} port -> 存活对象 { record, proxy, tunnel, abort, sync, lastTunnelAttempt } */
    this.shares = new Map();
    this.watchdog = null;
    this.cloudflaredBin = null;
    this.cloudflaredResolving = null;
    this.disposed = false;
  }

  // ---------- 对外 API（供工具调用） ----------

  /**
   * 新增一个端口共享。
   * @param {object} input
   * @param {number} input.port         本地服务端口（必填）
   * @param {string} [input.host]       本地服务地址（默认 127.0.0.1）
   * @param {string} [input.name]       备注名
   * @param {boolean} [input.lan]       是否局域网共享（默认 true）
   * @param {boolean} [input.public]    是否公网共享（默认 false）
   * @param {number} [input.publicPort] 局域网监听端口偏好（默认 = port；被占自动顺延）
   */
  async add(input = {}) {
    const port = asPort(input.port, 'port');
    if (this.shares.has(port)) {
      throw new Error(`端口 ${port} 已经在共享中（可用 port_share_update 修改，或先移除）`);
    }
    const host = String(input.host ?? '127.0.0.1').trim() || '127.0.0.1';
    const now = new Date().toISOString();
    const record = {
      id: randomUUID(),
      port,
      host,
      name: String(input.name ?? '').trim(),
      lan: input.lan !== false,
      public: !!input.public,
      publicPort: input.publicPort === undefined || input.publicPort === null || input.publicPort === ''
        ? null
        : asPort(input.publicPort, 'publicPort'),
      mode: null,             // 'proxy' | 'direct' | null
      lanPort: null,          // 实际局域网端口
      tunnelUrl: null,
      targetReachable: null,
      error: null,
      tunnelError: null,
      createdAt: now,
      updatedAt: now,
    };
    this.shares.set(port, { record, proxy: null, tunnel: null, abort: null, sync: null, lastTunnelAttempt: 0 });
    await this._sync(port);
    await this._persist();
    return this.status(port);
  }

  /**
   * 修改共享（只改传入的字段，其余不动）。
   * @param {object} input
   * @param {number} input.port 必填
   * @param {boolean} [input.lan]
   * @param {boolean} [input.public]
   * @param {string} [input.name]
   * @param {number} [input.publicPort]  局域网监听端口偏好（null 恢复自动）
   */
  async update(input = {}) {
    const port = asPort(input.port, 'port');
    const live = this.shares.get(port);
    if (!live) throw new Error(`端口 ${port} 未在共享中 | not shared`);
    const rec = live.record;
    if (input.lan !== undefined) rec.lan = !!input.lan;
    if (input.public !== undefined) rec.public = !!input.public;
    if (input.name !== undefined) rec.name = String(input.name ?? '').trim();
    if (input.publicPort !== undefined) {
      rec.publicPort = input.publicPort === null || input.publicPort === '' ? null : asPort(input.publicPort, 'publicPort');
    }
    await this._sync(port);
    await this._persist();
    return this.status(port);
  }

  /** 移除共享（停代理 + 杀隧道 + 删记录）。 */
  async remove(port) {
    port = asPort(port, 'port');
    const live = this.shares.get(port);
    if (!live) throw new Error(`端口 ${port} 未在共享中 | not shared`);
    this.shares.delete(port);
    await this._stopPublic(live);
    await this._stopLan(live);
    await this._persist();
    return { removed: true, port };
  }

  /** 单个共享的实时状态（含计算好的访问 URL）。 */
  status(port) {
    port = asPort(port, 'port');
    const live = this.shares.get(port);
    if (!live) throw new Error(`端口 ${port} 未在共享中 | not shared`);
    return this._view(live);
  }

  /** 全部共享状态。 */
  list() {
    return [...this.shares.values()].map((live) => this._view(live));
  }

  /** 插件启动时：按持久化记录自动恢复共享。 */
  async restore() {
    if (this.disposed) return;
    const records = await this.store.load();
    let restored = 0;
    for (const rec of records) {
      if (!rec || typeof rec.port !== 'number' || this.shares.has(rec.port)) continue;
      if (rec.lan === false && rec.public === false) continue; // 两路全关的纯记录不拉起
      this.shares.set(rec.port, {
        record: { ...rec, error: null, tunnelError: null, mode: null, lanPort: null, tunnelUrl: null },
        proxy: null, tunnel: null, abort: null, sync: null, lastTunnelAttempt: 0,
      });
      await this._sync(rec.port); // 顺序恢复，避免多条隧道同时抢带宽/下载
      restored += 1;
    }
    this._startWatchdog();
    if (restored > 0) this.logger?.info?.('dsh-port-share: 已自动恢复 %d 个端口共享', restored);
  }

  /** 插件卸载：停掉一切监听与隧道，但保留持久化记录（下次启动自动恢复）。 */
  async dispose() {
    this.disposed = true;
    if (this.watchdog) { clearInterval(this.watchdog); this.watchdog = null; }
    const ports = [...this.shares.keys()];
    for (const port of ports) {
      const live = this.shares.get(port);
      live.abort?.abort?.();
      await this._stopPublic(live);
      await this._stopLan(live);
    }
    this.shares.clear();
  }

  // ---------- 内部 ----------

  /** 串行化每个端口的同步，防止看门狗与手动操作交错。 */
  _sync(port) {
    const live = this.shares.get(port);
    if (!live) return Promise.resolve();
    const run = () => (this.disposed ? Promise.resolve() : this._syncInternal(port));
    live.sync = (live.sync ?? Promise.resolve()).then(run, run);
    return live.sync;
  }

  async _syncInternal(port) {
    const live = this.shares.get(port);
    if (!live) return;
    const rec = live.record;

    // 两路全关的共享：纯记录，什么都不拉起、也不探测
    if (!rec.lan && !rec.public) {
      await this._stopPublic(live);
      await this._stopLan(live);
      rec.mode = null;
      rec.lanPort = null;
      rec.tunnelUrl = null;
      rec.error = null;
      return;
    }

    rec.targetReachable = await probeTcp(rec.host, rec.port);
    if (!rec.targetReachable) {
      // 目标服务没起来：停掉监听，别占端口堵死用户之后要启动的服务
      await this._stopPublic(live);
      await this._stopLan(live);
      rec.mode = null;
      rec.lanPort = null;
      rec.tunnelUrl = null;
      rec.error = `目标服务 ${rec.host}:${rec.port} 未启动或不可达，共享暂停，等待服务启动后自动恢复`;
      return;
    }

    rec.error = null;
    if (rec.lan) {
      try { await this._ensureLan(port); } catch (err) { rec.error = `局域网共享失败：${err?.message ?? err}`; }
    } else {
      await this._stopLan(live);
      rec.mode = null;
      rec.lanPort = null;
    }

    if (rec.public) {
      const retryOk = Date.now() - live.lastTunnelAttempt >= TUNNEL_RETRY_MIN_MS;
      if (retryOk && !live.tunnel) {
        try { await this._ensurePublic(port); } catch (err) { rec.error = `公网隧道失败：${err?.message ?? err}`; }
      }
    } else {
      await this._stopPublic(live);
      rec.tunnelUrl = null;
    }

    rec.updatedAt = new Date().toISOString();
  }

  /** 确保局域网暴露就绪：优先直连（服务已绑全部接口），否则起 TCP 代理。 */
  async _ensureLan(port) {
    const live = this.shares.get(port);
    const rec = live.record;

    if (live.proxy || rec.mode === 'direct') return;

    // 直连检测：局域网 IP 上目标端口可达 → 服务自己已暴露
    const lanIp = lanIpv4();
    if (lanIp && await probeTcp(lanIp, rec.port)) {
      rec.mode = 'direct';
      rec.lanPort = rec.port;
      return;
    }

    // 代理模式：优先用户偏好端口（默认同端口）；服务只绑 loopback 时同端口必被占 → 顺延
    const want = rec.publicPort ?? rec.port;
    let proxy = null;
    try {
      proxy = await createTcpProxy({ bindPort: want, targetHost: rec.host, targetPort: rec.port });
    } catch (err) {
      if (err?.code !== 'EADDRINUSE') throw err;
      for (let p = Math.max(1, want + 1); p < want + 500 && p <= 65535; p++) {
        try {
          proxy = await createTcpProxy({ bindPort: p, targetHost: rec.host, targetPort: rec.port });
          break;
        } catch (e2) {
          if (e2?.code !== 'EADDRINUSE') throw e2;
        }
      }
    }
    if (!proxy) throw new Error('找不到空闲端口（连续 500 个都被占）| no free port found');
    live.proxy = proxy;
    rec.mode = 'proxy';
    rec.lanPort = proxy.port;
    this.logger?.info?.('dsh-port-share: 端口 %d 局域网代理就绪 0.0.0.0:%d → %s:%d', rec.port, proxy.port, rec.host, rec.port);
  }

  /** 确保公网隧道就绪（已存在则跳过；目标端口 = 代理端口或直连的服务端口）。 */
  async _ensurePublic(port) {
    const live = this.shares.get(port);
    const rec = live.record;
    if (live.tunnel) return;
    live.lastTunnelAttempt = Date.now();

    const bin = await this._getCloudflared();
    const targetPort = live.proxy ? live.proxy.port : rec.port;
    const controller = new AbortController();
    live.abort = controller;
    const tunnel = await startQuickTunnel({
      port: targetPort,
      bin,
      signal: controller.signal,
      onPhase: (p) => { rec.tunnelPhase = p; },
    });
    if (live.abort !== controller) { tunnel.kill(); return; } // 与 stop 竞态：已不需要
    live.tunnel = tunnel;
    rec.tunnelUrl = tunnel.url;
    rec.tunnelError = null;
    tunnel.onExit((code) => {
      if (controller.signal.aborted) return;
      live.tunnel = null;
      rec.tunnelUrl = null;
      rec.tunnelError = `cloudflared 进程退出（code=${code}），看门狗将自动重连`;
      this.logger?.warn?.('dsh-port-share: 端口 %d 公网隧道退出（code=%s）', rec.port, code);
    });
    this.logger?.info?.('dsh-port-share: 端口 %d 公网隧道就绪 %s', rec.port, tunnel.url);
  }

  async _stopLan(live) {
    if (!live?.proxy) return;
    const p = live.proxy;
    live.proxy = null;
    try { await p.close(); } catch { /* 已关闭等边缘情况 */ }
  }

  async _stopPublic(live) {
    if (!live) return;
    live.abort?.abort?.();
    live.abort = null;
    if (live.tunnel) {
      const t = live.tunnel;
      live.tunnel = null;
      t.kill();
    }
    live.record.tunnelUrl = null;
  }

  _getCloudflared() {
    if (this.cloudflaredBin) return Promise.resolve(this.cloudflaredBin);
    if (this.cloudflaredResolving) return this.cloudflaredResolving;
    this.cloudflaredResolving = resolveCloudflared({ home: this.home, cloudflaredPath: this.cloudflaredPath })
      .then((bin) => { this.cloudflaredBin = bin; return bin; })
      .finally(() => { this.cloudflaredResolving = null; });
    return this.cloudflaredResolving;
  }

  _startWatchdog() {
    if (this.watchdog || this.disposed) return;
    this.watchdog = setInterval(() => {
      if (this.disposed) return;
      for (const port of this.shares.keys()) void this._sync(port);
    }, WATCHDOG_MS);
    if (typeof this.watchdog.unref === 'function') this.watchdog.unref();
  }

  async _persist() {
    const records = [...this.shares.values()].map((live) => live.record);
    await this.store.save(records);
  }

  /** 组装对外视图（record + 实时运行状态 + 计算好的访问 URL）。 */
  _view(live) {
    const rec = live.record;
    const lanIp = lanIpv4();
    const lanPort = rec.lanPort ?? (rec.mode === 'direct' ? rec.port : null);
    const lanUrl = rec.mode && lanPort && lanIp ? `http://${lanIp}:${lanPort}` : null;
    return {
      ...rec,
      lanIp,
      lanPort,
      lanUrl,
      proxyRunning: !!live.proxy,
      tunnelRunning: !!live.tunnel,
      tunnelPhase: rec.tunnelPhase ?? null,
    };
  }
}
