// 冒烟测试：cloudflared 自动下载 → 快速隧道 → 公网访问（端到端）
// 用法：node test/smoke-tunnel.mjs [port]
import { createServer } from 'node:http';
import { resolveCloudflared, startQuickTunnel } from '../lib/tunnel.mjs';

const port = Number(process.argv[2] || 0);
const server = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(`tunnel-smoke-${Date.now()}`);
});
await new Promise((r) => server.listen(port, '127.0.0.1', r));
const localPort = server.address().port;
console.log(`[smoke] 本地服务 http://127.0.0.1:${localPort}`);

const bin = await resolveCloudflared({ onPhase: (p) => console.log(`[smoke] cloudflared: ${p}`) });
console.log(`[smoke] cloudflared binary: ${bin}`);

const t = await startQuickTunnel({ port: localPort, bin, onPhase: (p) => console.log(`[smoke] tunnel: ${p}`) });
console.log(`[smoke] 公网 URL: ${t.url}`);

const res = await fetch(t.url, { signal: AbortSignal.timeout(20_000) });
const body = await res.text();
console.log(`[smoke] 公网访问结果: HTTP ${res.status} -> ${body}`);
console.log(body.startsWith('tunnel-smoke-') ? '[smoke] ✅ 全链路正常' : '[smoke] ❌ 内容不符');

t.kill();
server.close();
process.exit(0);
