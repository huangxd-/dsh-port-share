// 离线验证 startQuickTunnel：用假 cloudflared（模拟真实输出格式）验证
// spawn → URL 解析 → onExit 生命周期 → kill，全程不联网。
//
// 环境限制下的优雅跳过：
//   - 本沙箱禁止任何子进程 spawn（EPERM）→ 跳过；
//   - Windows 无法直接 spawn 非 .exe 脚本（EINVAL，真实 cloudflared 是 .exe 不受影响）→ 跳过。
// 在 Linux/macOS CI 上会真正执行。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startQuickTunnel } from '../lib/tunnel.mjs';

const fakeBin = join(dirname(fileURLToPath(import.meta.url)), 'fake-cloudflared.mjs');

async function runOrSkip(name, fn) {
  await test(name, async (t) => {
    try {
      await fn(t);
    } catch (err) {
      if (err?.code === 'EPERM' || err?.code === 'EINVAL' || err?.errno === -4048) {
        t.skip(`环境不允许 spawn（${err.code}），跳过离线隧道验证`);
        return;
      }
      throw err;
    }
  });
}

await runOrSkip('startQuickTunnel：解析隧道 URL + 正常 kill', async (t) => {
  const phases = [];
  const tunnel = await startQuickTunnel({ port: 9999, bin: fakeBin, onPhase: (p) => phases.push(p) });
  assert.match(tunnel.url, /^https:\/\/fake-abc-123\.trycloudflare\.com$/);
  assert.ok(phases.includes('ready'), '应有 ready 阶段');
  tunnel.kill();
  await new Promise((r) => setTimeout(r, 300));
});

await runOrSkip('startQuickTunnel：进程退出触发 onExit 回调', async (t) => {
  const tunnel = await startQuickTunnel({ port: 9999, bin: fakeBin });
  let exitCode = null;
  tunnel.onExit((code) => { exitCode = code; });
  tunnel.kill();
  await new Promise((r) => setTimeout(r, 500));
  assert.notEqual(exitCode, null, 'kill 后应触发 onExit');
});

await runOrSkip('startQuickTunnel：二进制不存在/损坏 → 清晰报错', async (t) => {
  try {
    await startQuickTunnel({ port: 9999, bin: join(dirname(fakeBin), 'no-such-cloudflared') });
    assert.fail('应抛错');
  } catch (err) {
    if (err?.code === 'EPERM' || err?.code === 'EINVAL') {
      t.skip(`环境不允许 spawn（${err.code}），跳过`);
      return;
    }
    assert.match(String(err?.message ?? err), /cloudflared 启动失败/);
  }
});
