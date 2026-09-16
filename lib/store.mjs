// dsh-port-share 持久化：共享配置存 $DSH_HOME/dsh-port-share/shares.json
//
// 记录数组（每条 = 一个被共享的端口）：
//   { id, port, host, name, lan, public, publicPort, mode, tunnelUrl,
//     targetReachable, error, createdAt, updatedAt }
// 文件是「自动恢复」的来源：插件重启后 restore() 会按记录的 lan/public
// 开关重新拉起局域网代理与公网隧道（与 dsh-pocket 的 tunnel-auto.json 同理，
// 只是这里每个端口一条记录、开关是显式字段）。
//
// 写入必须串行：并发 add/remove/update 都改同一份数组，若异步 writeFile
// 交错，先写后写可能互相覆盖丢数据。这里用 promise 队列把落盘串起来。

import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

/** 插件状态目录（$DSH_HOME 可被 DSH 宿主注入，否则 ~/.dsh）。 */
export function stateDir(home) {
  const base = home ?? process.env.DSH_HOME ?? join(homedir(), '.dsh');
  return join(base, 'dsh-port-share');
}

/** 创建持久化存储。 */
export function createStore({ home } = {}) {
  const file = join(stateDir(home), 'shares.json');
  let queue = Promise.resolve();
  return {
    /** 当前共享记录文件路径（排障/手工编辑用）。 */
    file,
    /** 读取全部记录；无文件/损坏返回空数组。 */
    async load() {
      try {
        const raw = JSON.parse(await readFile(file, 'utf8'));
        return Array.isArray(raw) ? raw : [];
      } catch {
        return [];
      }
    },
    /** 整体覆写（串行落盘）。 */
    save(records) {
      queue = queue.then(async () => {
        try {
          await mkdir(dirname(file), { recursive: true });
          await writeFile(file, JSON.stringify(records, null, 2), { mode: 0o600 });
        } catch { /* 落盘失败不致命，内存态仍可用 */ }
      });
      return queue;
    },
  };
}

export { rm };
