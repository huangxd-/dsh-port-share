// dsh-port-share 局域网能力：IP 选择 + TCP 探测 + 通用 TCP 反向代理
//
// 为什么需要代理：本地 Node 开发服务通常只监听 127.0.0.1（或仅 loopback），
// 手机在局域网里够不到。插件在 0.0.0.0:<端口> 起一个通用 TCP 代理，把入站
// 连接原样转发到 127.0.0.1:<目标端口>——HTTP / WebSocket / 任意 TCP 协议
// 都能透传，不需要服务端做任何改动。
//
// 端口冲突自适应（重要）：若目标服务本身已经绑了 0.0.0.0 / [::]（Node 默认
// `server.listen(port)` 就是绑全部接口），此时 0.0.0.0:<同端口> 会被
// EADDRINUSE 拒绝。调用方（manager）先探测局域网 IP 上目标端口是否可达：
//   - 可达 → 直连模式（服务已暴露，无需代理）；
//   - 不可达 → 服务只绑了 loopback → 代理模式，同端口被占时自动顺延找空端口。

import { createServer, connect } from 'node:net';
import { networkInterfaces } from 'node:os';

// RFC1918 私网 + CGNAT 100.64/10（Tailscale / ZeroTier 默认网段），手机通常可达
const PRIVATE_IPV4_RE = /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|100\.(?:6[4-9]|[7-9]\d|1(?:0\d|1\d|2[0-7]))\.)/;

/** 名称像真实物理网卡的接口（加分）。 */
const PHYSICAL_IFACE_RE = /^(?:wlan|wi-?fi|wireless|ethernet|eth\d|en\d|wlp\d|以太网|有线|无线|本地连接)/i;

/** 常见的 VPN / 虚拟网卡名称（减分）：手机通常无法通过它们直连。 */
const VPN_IFACE_RE = /(?:radmin|tailscale|zerotier|easytier|et_|tun|tap|vpn|vethernet|virtual|vmware|virtualbox|wsl|docker|teredo|hamachi|bluetooth|bridge)/i;

/**
 * 从 os.networkInterfaces() 里选出手机最可能可达的 IPv4（规则见 dsh-pocket）：
 * 私网地址优先，物理网卡名加分，VPN/虚拟网卡减分，同分保持枚举顺序。
 * @param {ReturnType<typeof networkInterfaces>} interfaces
 * @returns {string|null}
 */
export function selectLanIPv4(interfaces) {
  const candidates = [];
  for (const [name, addrs] of Object.entries(interfaces ?? {})) {
    for (const addr of addrs ?? []) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      const ip = addr.address;
      if (!ip || ip.startsWith('127.') || ip.startsWith('169.254.')) continue;

      let score = 0;
      if (PRIVATE_IPV4_RE.test(ip)) score += 100;
      if (PHYSICAL_IFACE_RE.test(name)) score += 20;
      else if (VPN_IFACE_RE.test(name)) score -= 50;

      candidates.push({ ip, score, order: candidates.length });
    }
  }
  candidates.sort((a, b) => b.score - a.score || a.order - b.order);
  return candidates[0]?.ip ?? null;
}

/** 当前局域网 IPv4（实时探测，不做缓存——用户可能切 WiFi）。 */
export function lanIpv4() {
  return selectLanIPv4(networkInterfaces());
}

/**
 * TCP 连通性探测。
 * @param {string} host
 * @param {number} port
 * @param {{timeoutMs?: number}} [opts]
 * @returns {Promise<boolean>}
 */
export function probeTcp(host, port, { timeoutMs = 1500 } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const sock = connect({ host, port });
    const done = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { sock.destroy(); } catch { /* 忽略 */ }
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

/**
 * 通用 TCP 反向代理：监听 bindHost:bindPort，把入站连接转发到
 * targetHost:targetPort。任一端断开/出错都会清理另一端，不留僵尸。
 * @param {object} opts
 * @param {string} [opts.bindHost]  监听地址（默认 0.0.0.0）
 * @param {number} opts.bindPort    监听端口（0 = 系统分配）
 * @param {string} opts.targetHost  上游主机（默认 127.0.0.1）
 * @param {number} opts.targetPort  上游端口
 * @returns {Promise<{port:number, close:()=>Promise<void>}>}
 */
export async function createTcpProxy({ bindHost = '0.0.0.0', bindPort, targetHost = '127.0.0.1', targetPort } = {}) {
  return new Promise((resolve, reject) => {
    const sockets = new Set();
    const server = createServer((client) => {
      const upstream = connect({ host: targetHost, port: targetPort });
      sockets.add(client);
      sockets.add(upstream);
      const drop = () => { sockets.delete(client); sockets.delete(upstream); };
      const teardown = () => {
        try { client.destroy(); } catch { /* 忽略 */ }
        try { upstream.destroy(); } catch { /* 忽略 */ }
        drop();
      };
      client.on('error', teardown);
      upstream.on('error', teardown);
      client.on('close', teardown);
      upstream.on('close', teardown);
      upstream.on('connect', () => {
        client.pipe(upstream);
        upstream.pipe(client);
      });
    });
    // 未处理的连接 error 会崩进程，这里统一吞掉（teardown 已接管清理）
    server.on('connection', (sock) => {
      sockets.add(sock);
      sock.on('close', () => sockets.delete(sock));
      sock.on('error', () => {});
    });
    server.once('error', reject); // EADDRINUSE / EACCES 等，立刻抛给上层
    server.listen(bindPort, bindHost, () => {
      const port = server.address().port;
      resolve({
        port,
        close: () => new Promise((r) => {
          for (const s of sockets) { try { s.destroy(); } catch { /* 忽略 */ } }
          server.close(() => r());
        }),
      });
    });
  });
}
