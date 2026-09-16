// dsh-port-share 插件入口（单包单插件：多端口共享，全在这一个包里）
//
// 用法（手机/电脑上直接对 DSH 说人话，模型会调用下面的 port_share_* 工具）：
//   - 「把 3000 端口分享到局域网」       → port_share_add { port: 3000 }
//   - 「把 8080 端口也通过公网分享」     → port_share_add { port: 8080, public: true }
//   - 「现在有哪些端口在共享？」         → port_share_list
//   - 「停掉 3000 的共享」               → port_share_remove { port: 3000 }
//   - 「把 4000 的公网分享关掉」         → port_share_update { port: 4000, public: false }
//
// 工具注册用「原始 JSON-Schema ToolDefinition」而非 defineTool：不依赖
// @deepseek-ai/dsh-tools 包，天然避开该包双实例导致的 symbol 错位问题
// （deepseek-ai/deepseek-harness#1697：装了依赖 dsh-tools 的插件后所有工具调用
// 报 Cannot read properties of undefined (reading 'prepare')）。
// 代价是参数/返回值校验由本插件自己负责——见 manager 里的 asPort 等校验。

import { homedir } from 'node:os';
import { join } from 'node:path';
import { ShareManager } from './manager.mjs';

export const name = 'dsh-port-share';
export const inject = ['tools'];

// ---------- 工具定义 ----------

const PORT_PARAM = {
  type: 'integer',
  description: '本地网络服务监听的端口（1-65535），即要被共享的端口',
};
const HOST_PARAM = {
  type: 'string',
  description: '本地服务所在地址，默认 127.0.0.1',
};
const NAME_PARAM = {
  type: 'string',
  description: '该共享的备注名，方便识别（如「node api 测试服务」）',
};
const LAN_PARAM = {
  type: 'boolean',
  description: '是否共享到局域网（同 WiFi/网段内手机可访问），默认 true',
};
const PUBLIC_PARAM = {
  type: 'boolean',
  description: '是否通过 cloudflare 快速隧道共享到公网（任意网络可访问，URL 随机且重启会变），默认 false',
};
const PUBLIC_PORT_PARAM = {
  type: 'integer',
  description: '局域网监听端口偏好；默认与本地端口相同，被占用时自动顺延找空闲端口',
};

/** 状态视图的输出 schema（宽松 object：record 字段多且可变）。 */
const RECORD_SCHEMA = {
  type: 'object',
  description: '该端口共享的完整状态，字段含义见 render 文本',
};

function text(value) {
  return [{ type: 'text', text: value }];
}

/** 把状态视图渲染成给用户看的文本（中文优先）。 */
function renderShare(s) {
  const lines = [];
  const tag = s.name ? `${s.port}（${s.name}）` : s.port;
  lines.push(`端口 ${tag}：${s.targetReachable ? '✅ 运行中' : '⏳ 目标服务未启动'}`);
  lines.push(`  本地服务: ${s.host}:${s.port}`);
  if (s.lan) {
    lines.push(`  局域网${s.lanUrl ? `: ${s.lanUrl}` : ': 未就绪'}`);
    if (s.mode === 'proxy') lines.push(`    （TCP 代理 0.0.0.0:${s.lanPort} → ${s.host}:${s.port}）`);
    if (s.mode === 'direct') lines.push('    （服务已绑定全部接口，直连）');
  } else {
    lines.push('  局域网: 已关闭');
  }
  if (s.public) {
    if (s.tunnelUrl) lines.push(`  公网: ${s.tunnelUrl}`);
    else lines.push(`  公网: 未就绪${s.tunnelError ? `（${s.tunnelError}）` : ''}`);
  } else {
    lines.push('  公网: 已关闭');
  }
  if (s.error && !(s.targetReachable === false)) lines.push(`  ⚠️ ${s.error}`);
  if (s.lan && s.lanUrl && s.lanIp) {
    lines.push(`  📱 手机（同一网络）直接打开上面的局域网地址即可测试`);
  }
  return lines.join('\n');
}

function renderList(items) {
  if (items.length === 0) return '当前没有端口在共享。用 port_share_add 添加，例如「把 3000 端口分享到局域网」。';
  return items.map((s, i) => `${i + 1}. ${renderShare(s)}`).join('\n\n');
}

/** 工具定义工厂。 */
function tool({ name: toolName, description, parameters, outputSchema, render, execute }) {
  // 原始 JSON-Schema 的 required 必须是根级数组（不能是属性内的布尔标记），
  // 这里把每个属性 spec 里的 required: true 提出来组装成根级 required。
  const properties = {};
  const required = [];
  for (const [key, spec] of Object.entries(parameters ?? {})) {
    const { required: req, ...rest } = spec;
    properties[key] = rest;
    if (req) required.push(key);
  }
  return {
    name: toolName,
    description,
    parameters: { type: 'object', properties, required },
    output: {
      schema: outputSchema,
      render: (args, value) => text(render(value)),
    },
    async execute(args, exec) {
      // 原始注册不做参数校验，这里显式透传（exec.signal 供调用方取消）
      const result = await execute({ ...(args ?? {}), signal: exec?.signal });
      return result;
    },
  };
}

// ---------- apply ----------

/**
 * 构建本插件的全部工具定义（导出供测试直接校验 schema 合规性）。
 * @param {ShareManager} manager
 * @returns {object[]} 可直接传给 ctx.tools.register 的原始 ToolDefinition
 */
export function buildToolDefs(manager) {
  return [
    tool({
      name: 'port_share_add',
      description: '把本地网络服务的一个端口分享出去：默认共享到局域网（同 WiFi 手机可访问）；传 public: true 再通过 cloudflare 快速隧道暴露到公网（任意网络可访问）。多个端口可同时共享（多次调用即可）。',
      parameters: {
        port: { ...PORT_PARAM, required: true },
        host: HOST_PARAM,
        name: NAME_PARAM,
        lan: LAN_PARAM,
        public: PUBLIC_PARAM,
        publicPort: PUBLIC_PORT_PARAM,
      },
      outputSchema: RECORD_SCHEMA,
      render: renderShare,
      execute: (args) => manager.add(args),
    }),
    tool({
      name: 'port_share_list',
      description: '列出当前所有被共享的端口及其访问地址（局域网 URL / 公网 URL）和运行状态。',
      parameters: {},
      outputSchema: { type: 'array', items: RECORD_SCHEMA },
      render: renderList,
      execute: () => manager.list(),
    }),
    tool({
      name: 'port_share_status',
      description: '查看某个端口共享的详细状态：目标服务是否可达、局域网/公网访问地址、代理与隧道运行情况。',
      parameters: { port: { ...PORT_PARAM, required: true } },
      outputSchema: RECORD_SCHEMA,
      render: renderShare,
      execute: (args) => manager.status(args.port),
    }),
    tool({
      name: 'port_share_update',
      description: '修改一个已有端口共享：可开关局域网（lan）/公网（public）分享、改备注名（name）、改局域网监听端口（publicPort）。只改传入的字段。',
      parameters: {
        port: { ...PORT_PARAM, required: true },
        lan: LAN_PARAM,
        public: PUBLIC_PARAM,
        name: NAME_PARAM,
        publicPort: PUBLIC_PORT_PARAM,
      },
      outputSchema: RECORD_SCHEMA,
      render: renderShare,
      execute: (args) => manager.update(args),
    }),
    tool({
      name: 'port_share_remove',
      description: '移除一个端口共享：停掉局域网代理和公网隧道，之后该端口不再被分享。',
      parameters: { port: { ...PORT_PARAM, required: true } },
      outputSchema: { type: 'object', description: '移除结果' },
      render: (v) => `已移除端口 ${v.port} 的共享`,
      execute: (args) => manager.remove(args.port),
    }),
  ];
}

export function apply(ctx, config = {}) {
  const logger = ctx.logger?.(name) ?? console;
  const home = config.home ?? process.env.DSH_HOME ?? join(homedir(), '.dsh');
  const manager = new ShareManager({ home, logger, cloudflaredPath: config.cloudflaredPath ?? '' });

  for (const def of buildToolDefs(manager)) {
    ctx.tools.register(def);
  }

  // 开机自动恢复上次的共享（DSH 重启后 cloudflared 子进程会被杀，记录在磁盘上）
  void manager.restore().catch((err) => {
    logger.error('dsh-port-share: 自动恢复失败: %s', err?.message ?? err);
  });

  ctx.effect(() => async () => {
    await manager.dispose();
  }, 'dsh-port-share: stop all port shares');
}
