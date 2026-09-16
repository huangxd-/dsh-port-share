// cloudflared 快速隧道：把本机一个端口暴露成公网 https URL
//
// 每个被共享的端口 = 一个独立的 `cloudflared tunnel --url` 子进程，各自拿到
// 一条随机的 https://<子域>.trycloudflare.com 地址（每次重启会变）。
//
// 二进制解析优先级（与 dsh-pocket 一致）：
//   1. 环境变量 DSH_PORT_SHARE_CLOUDFLARED 或插件配置 cloudflaredPath（用户自备）；
//   2. PATH 里已有的 cloudflared（winget / apt / brew 装的）；
//   3. 持久缓存 $DSH_HOME/dsh-port-share/bin/cloudflared[.exe]，缺失才下载。
// 下载源：官方 GitHub Release + ghproxy.net / gh.ddlc.top / gh-proxy.com 加速镜像，
// 多线程分块（Windows 官方源单线程很慢，实测 8 并发能拉满带宽）。

import { spawn, execSync } from 'node:child_process';
import { mkdir, access, chmod, rm, stat, rename, cp, open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { createWriteStream } from 'node:fs';

// 快速隧道 URL：https://<随机子域>.trycloudflare.com
// (?!api\.) 负向前瞻排除保留子域 api（cloudflared 输出会先出现
// https://api.trycloudflare.com 注册地址，原正则会把误当隧道 URL）。
export const QUICK_TUNNEL_URL_RE = /https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/i;

/** cloudflared 输出里最有诊断价值的一段：参数错误在开头，运行期错误在尾部。 */
export function firstMeaningfulErrorLine(buf) {
  const lines = String(buf ?? '').trim().split(/\r?\n/);
  const usageIdx = lines.findIndex((l) => /^(?:Incorrect Usage|flag provided but not defined|unknown flag|unknown command)/i.test(l.trim()));
  if (usageIdx >= 0) return lines[usageIdx].trim().slice(0, 500);
  return lines.slice(-4).join('\n').trim().slice(0, 500);
}

function platformBinary() {
  const archMap = { x64: 'amd64', arm64: 'arm64', ia32: '386', arm: 'arm' };
  const a = archMap[process.arch] ?? process.arch;
  const os = process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'windows' : 'linux';
  return { os, a, ext: os === 'windows' ? '.exe' : '' };
}

/** 候选发布资产名：linux 用裸二进制（免解压、不依赖 tar），darwin/windows 按官方布局。 */
export function platformAssets() {
  const { os, a } = platformBinary();
  if (os === 'windows') return [`cloudflared-windows-${a}.exe`];
  if (os === 'darwin') return [`cloudflared-darwin-${a}.tgz`];
  return [`cloudflared-linux-${a}`, `cloudflared-linux-${a}.tgz`];
}

/** 下载源（按顺序逐个尝试）：官方 GitHub + 国内加速镜像。 */
const CLOUDFLARED_MIRRORS = [
  (asset) => `https://github.com/cloudflare/cloudflared/releases/latest/download/${asset}`,
  (asset) => `https://ghproxy.net/https://github.com/cloudflare/cloudflared/releases/latest/download/${asset}`,
  (asset) => `https://gh.ddlc.top/https://github.com/cloudflare/cloudflared/releases/latest/download/${asset}`,
  (asset) => `https://gh-proxy.com/https://github.com/cloudflare/cloudflared/releases/latest/download/${asset}`,
];

const PARALLEL_SEGMENTS = 8;
const MIN_PARALLEL_SIZE = 8 * 1024 * 1024;   // 小于 8MB 不值得分块
const PROBE_SIZE = 2 * 1024 * 1024;          // 探针大小：先单线程下这么多测速
const SLOW_SPEED_THRESHOLD = 0.3;            // bytes/ms：低于它视为慢网络

function hostOf(url) {
  try { return new URL(url).host; } catch { return url; }
}

async function mergeParts(partFiles, dest) {
  const { createReadStream } = await import('node:fs');
  const out = createWriteStream(dest);
  try {
    for (const f of partFiles) {
      await new Promise((resolve, reject) => {
        const rs = createReadStream(f);
        rs.on('error', reject);
        rs.pipe(out, { end: false });
        rs.on('end', resolve);
      });
    }
  } finally {
    await new Promise((r) => out.end(r));
  }
}

/**
 * 下载文件到 dest（自适应，来自 dsh-pocket 的成熟实现）：
 * 1. 服务器不支持 Range 或文件小 → 单线程；
 * 2. 单线程下载探针测速，够快 → 继续单线程（部分网络/服务器并发反而更慢）；
 * 3. 探针速度低（典型慢网络，如 Windows 官方源 ~200KB/s）→ 8 段并发分块。
 * @returns {Promise<number>} 实际下载字节数
 */
export async function downloadFile(url, dest, { signal, segments = PARALLEL_SEGMENTS } = {}) {
  let head = null;
  try { head = await fetch(url, { method: 'HEAD', signal }); } catch { head = null; }
  const len = head ? Number(head.headers.get('content-length') || 0) : 0;
  const acceptsRanges = head ? String(head.headers.get('accept-ranges') || '').toLowerCase() === 'bytes' : false;

  if (!head || !acceptsRanges || len < MIN_PARALLEL_SIZE) {
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
    return len || 0;
  }

  // 探针测速
  const probeBytes = Math.min(PROBE_SIZE, len);
  const probeStart = Date.now();
  try {
    const probeRes = await fetch(url, { signal, headers: { Range: `bytes=0-${probeBytes - 1}` } });
    if (!probeRes.ok) throw new Error(`HTTP ${probeRes.status} (probe)`);
    const probeBody = await probeRes.arrayBuffer();
    const probeMs = Date.now() - probeStart;
    const probeSpeed = probeMs > 0 ? probeBytes / probeMs : Infinity;
    if (probeMs < 500 || probeSpeed >= SLOW_SPEED_THRESHOLD) {
      const { createWriteStream: cws, createReadStream: crs } = await import('node:fs');
      const w = cws(dest);
      await new Promise((resolve, reject) => {
        w.on('error', reject);
        w.write(Buffer.from(probeBody));
        w.end(resolve);
      });
      const restRes = await fetch(url, { signal, headers: { Range: `bytes=${probeBytes}-${len - 1}` } });
      if (!restRes.ok) throw new Error(`HTTP ${restRes.status} (rest)`);
      await pipeline(Readable.fromWeb(restRes.body), cws(dest, { flags: 'a' }));
      return len;
    }
    await rm(dest, { force: true }).catch(() => {});
  } catch (err) {
    await rm(dest, { force: true }).catch(() => {});
    if (!/HTTP|fetch/i.test(String(err?.message ?? ''))) throw err;
  }

  // 分块并发
  const parts = [];
  const chunk = Math.ceil(len / segments);
  for (let i = 0; i < segments; i++) {
    const start = i * chunk;
    const end = i === segments - 1 ? len - 1 : Math.min(start + chunk - 1, len - 1);
    if (start > end) break;
    parts.push({ start, end, file: `${dest}.part${i}` });
  }
  try {
    await Promise.all(parts.map(async (p) => {
      const res = await fetch(url, { signal, headers: { Range: `bytes=${p.start}-${p.end}` } });
      if (!res.ok) throw new Error(`HTTP ${res.status} (range ${p.start}-${p.end})`);
      await pipeline(Readable.fromWeb(res.body), createWriteStream(p.file));
    }));
    await mergeParts(parts.map((p) => p.file), dest);
  } finally {
    await Promise.all(parts.map((p) => rm(p.file, { force: true }).catch(() => {})));
  }
  return len;
}

async function downloadCloudflared(binPath, signal) {
  const { os, a, ext } = platformBinary();
  const dir = dirname(binPath);
  const tmpFile = join(dir, 'cloudflared.download');
  const fetchSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000);

  const assets = platformAssets();
  let lastErr = null;
  let usedAsset = null;

  for (let ai = 0; ai < assets.length && usedAsset === null; ai++) {
    const asset = assets[ai];
    for (let i = 0; i < CLOUDFLARED_MIRRORS.length; i++) {
      const url = CLOUDFLARED_MIRRORS[i](asset);
      console.log(`⬇️  下载 cloudflared（${asset}，源 ${i + 1}/${CLOUDFLARED_MIRRORS.length}：${hostOf(url)}）…`);
      try {
        await downloadFile(url, tmpFile, { signal: fetchSignal });
        const st = await stat(tmpFile);
        if (st.size < 1024 * 1024) throw new Error(`文件异常小（${st.size} 字节），疑似镜像错误页`);
        usedAsset = asset;
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        await rm(tmpFile, { force: true }).catch(() => {});
        console.warn(`  ⚠️ 源 ${i + 1} 失败：${err?.message ?? err}，尝试下一个…`);
      }
    }
  }
  if (usedAsset === null) {
    throw new Error(
      `cloudflared 下载失败：所有源都不通（最后错误：${lastErr?.message ?? lastErr}）。`
      + (os === 'windows'
        ? `可手动安装后重试：winget install cloudflared；或下载 ${assets[0]} 放到 ${dir} | download failed — try: winget install cloudflared, or put the exe into ${dir}`
        : `可自己装好后设置环境变量 DSH_PORT_SHARE_CLOUDFLARED 或插件配置 cloudflaredPath 跳过下载 | all mirrors failed — install cloudflared and set DSH_PORT_SHARE_CLOUDFLARED`),
    );
  }

  const extracted = join(dir, `cloudflared${ext}`);
  if (!usedAsset.endsWith('.tgz')) {
    await rename(tmpFile, extracted).catch(async () => { await cp(tmpFile, extracted).catch(() => {}); });
  } else {
    const extractDir = join(dir, `.extract-${process.pid}-${Date.now()}`);
    await mkdir(extractDir, { recursive: true });
    try {
      await new Promise((resolve, reject) => {
        const child = spawn('tar', ['-xzf', tmpFile, '-C', extractDir], { stdio: 'ignore' });
        child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`cloudflared 解压失败（code=${code}）`)));
        child.once('error', (err) => reject(err?.code === 'ENOENT' ? new Error('系统里没有 tar 命令，无法解压') : err));
      });
      const { readdir } = await import('node:fs/promises');
      let found = null;
      const direct = join(extractDir, `cloudflared${ext}`);
      try { if ((await stat(direct)).isFile()) found = direct; } catch { /* 不存在 */ }
      if (!found) {
        const verDir = join(extractDir, 'cloudflared');
        try {
          const vers = await readdir(verDir);
          for (const v of vers) {
            const bin = join(verDir, v, 'bin', `cloudflared${ext}`);
            try { if ((await stat(bin)).isFile()) { found = bin; break; } } catch { /* 继续 */ }
          }
        } catch { /* 无此目录 */ }
      }
      if (!found) throw new Error('cloudflared 解压成功但未找到二进制');
      if (found !== extracted) {
        await rename(found, extracted).catch(async () => { await cp(found, extracted).catch(() => {}); });
      }
    } finally {
      await rm(extractDir, { recursive: true, force: true }).catch(() => {});
    }
  }
  if (os !== 'windows') await chmod(extracted, 0o755);
  await rm(tmpFile, { force: true }).catch(() => {});
  return extracted;
}

/** PATH 里是否已有 cloudflared。 */
function cloudflaredOnPath() {
  try {
    execSync(process.platform === 'win32' ? 'where cloudflared' : 'command -v cloudflared', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** in-flight 下载单飞：并发调用复用同一次，防交错写入损坏。 */
let downloading = null;

/**
 * 拿一个可用的 cloudflared 路径（优先自定义 → PATH → 缓存 → 下载）。
 * @param {object} [opts]
 * @param {string} [opts.home]   $DSH_HOME（二进制持久缓存目录）
 * @param {string} [opts.cloudflaredPath]  用户指定的二进制路径（env 或插件配置）
 * @param {(phase:string)=>void} [opts.onPhase]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<string>} 可 spawn 的路径或命令名
 */
export async function resolveCloudflared({ home, cloudflaredPath = '', onPhase = () => {}, signal } = {}) {
  const explicit = cloudflaredPath || process.env.DSH_PORT_SHARE_CLOUDFLARED;
  if (explicit) {
    try {
      await access(explicit);
      return explicit;
    } catch {
      throw new Error(`DSH_PORT_SHARE_CLOUDFLARED 指向的路径不可用：${explicit} | cloudflaredPath is set but not accessible: ${explicit}`);
    }
  }
  if (cloudflaredOnPath()) return 'cloudflared';
  const dshHome = home ?? process.env.DSH_HOME ?? join(homedir(), '.dsh');
  const cacheDir = join(dshHome, 'dsh-port-share', 'bin');
  const { os, a, ext } = platformBinary();
  const candidates = [
    join(cacheDir, `cloudflared${ext}`),
    join(cacheDir, `cloudflared-${os}-${a}${ext}`),
  ];
  for (const bin of candidates) {
    try {
      await access(bin);
      if (os === 'linux') {
        // 丢弃 Homebrew bottle 坏缓存：ELF 解释器是 @@HOMEBREW_PREFIX@@ 占位符
        try {
          const fd = await open(bin, 'r');
          const head = Buffer.alloc(8192);
          await fd.read(head, 0, 8192, 0);
          await fd.close();
          if (head.includes('@@HOMEBREW_PREFIX@@')) {
            await rm(bin, { force: true }).catch(() => {});
            continue;
          }
        } catch { /* 读失败按正常缓存处理 */ }
      }
      return bin;
    } catch { /* 继续找下一个 */ }
  }
  onPhase('downloading');
  await mkdir(cacheDir, { recursive: true });
  if (!downloading) {
    downloading = downloadCloudflared(join(cacheDir, `cloudflared${ext}`), signal).finally(() => { downloading = null; });
  }
  return downloading;
}

/**
 * 启动 cloudflared 快速隧道，返回公网 URL。
 * @param {object} opts
 * @param {number} opts.port    本机目标端口（代理端口或直连的服务端口）
 * @param {string} opts.bin     resolveCloudflared 返回的可执行路径
 * @param {AbortSignal} [opts.signal]
 * @param {(phase:string)=>void} [opts.onPhase] 进度回调：downloading→starting→registering→ready
 * @returns {Promise<{url:string, kill:()=>void, onExit:(cb:(code:number|null)=>void)=>()=>void}>}
 */
export async function startQuickTunnel({ port, bin, signal, onPhase = () => {} }) {
  // 强制 HTTP/2（TCP 443）而不是默认的 QUIC（UDP 7844）：国内/企业网常屏蔽 UDP → error 1033
  // `--no-autoupdate` 必须在全局位置（子命令之前）：2026.x 起子命令层级已移除该 flag
  const child = spawn(bin, ['--no-autoupdate', 'tunnel', '--url', `http://127.0.0.1:${port}`, '--protocol', 'http2'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  onPhase('starting');
  let cleanup = null;
  let rejectErr = null;
  // spawn 失败（缓存二进制损坏等）必须接住，否则 uncaughtException 崩宿主
  child.on('error', (err) => {
    cleanup?.();
    onPhase?.('error');
    rejectErr?.(new Error(`cloudflared 启动失败：${err?.message ?? err}（可删除 $DSH_HOME/dsh-port-share/bin 缓存后重试）`));
  });
  onPhase('registering');

  const url = await new Promise((resolve, reject) => {
    let buf = '';
    const onData = (chunk) => {
      buf += String(chunk);
      const m = buf.match(QUICK_TUNNEL_URL_RE);
      if (m) {
        cleanup();
        onPhase('ready');
        resolve(m[0]);
      }
    };
    const onExit = (code) => {
      cleanup();
      const tail = firstMeaningfulErrorLine(buf);
      reject(new Error(`cloudflared 退出（code=${code}）${tail ? '：' + tail : ''}`));
    };
    cleanup = () => {
      child.stdout.off('data', onData);
      child.stderr.off('data', onData);
      child.off('exit', onExit);
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      // 摘掉监听后管道不再消费 → 64KB 缓冲填满会阻塞 cloudflared → 继续吞掉输出
      child.stdout.resume();
      child.stderr.resume();
    };
    const onAbort = () => {
      cleanup();
      child.kill();
      reject(new Error('已取消 | cancelled'));
    };
    const timer = setTimeout(() => {
      cleanup();
      child.kill();
      reject(new Error(
        'cloudflared 启动超时（30s）——请检查是否开着代理/VPN（Clash 等 TUN 模式会掐断隧道连接），退出代理后重试 | '
        + 'timeout — if you run a proxy/VPN (Clash etc., TUN mode), it can block the tunnel; quit it and retry',
      ));
    }, 30_000);

    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', onExit);
    signal?.addEventListener('abort', onAbort, { once: true });
    rejectErr = reject;
  });

  // 隧道进程运行中死亡 → 通知监听方（manager 把状态从 ready 打回）
  const exitListeners = new Set();
  child.on('exit', (code) => {
    for (const cb of exitListeners) cb(code);
  });

  return {
    url,
    kill: () => {
      try { child.kill(); } catch { /* 忽略 */ }
    },
    onExit: (cb) => {
      exitListeners.add(cb);
      return () => exitListeners.delete(cb);
    },
  };
}
