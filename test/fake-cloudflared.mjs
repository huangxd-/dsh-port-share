#!/usr/bin/env node
// 假的 cloudflared：模拟真实快速隧道的输出格式，用于离线验证 startQuickTunnel。
// 真实 cloudflared 会先打印注册信息，再打印隧道 URL（可能带颜色/前缀），
// 本脚本复刻关键时序：URL 在启动后 ~200ms 出现。
console.log('INF 2026-01-01T00:00:00Z Requesting new quick Tunnel on trycloudflare.com...');
setTimeout(() => {
  console.log('INF 2026-01-01T00:00:00Z https://fake-abc-123.trycloudflare.com registered conn 0');
}, 200);
setInterval(() => {}, 1000); // 保持进程存活，直到被杀
