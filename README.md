# dsh-port-share

把本地网络服务分享给**局域网**和**公网**的 DSH 插件：自定义端口、**多端口同时共享**，手机随时随地测试你的 Node 服务。

> 参考 [shaobeichen/dsh-pocket](https://github.com/shaobeichen/dsh-pocket)（把 DSH 本身装进口袋）设计思路，本插件把同样的「局域网 + Cloudflare 公网」能力泛化成任意端口的通用分享工具。

## 它能做什么

| 场景 | 做法 | 结果 |
|---|---|---|
| 电脑上起了个 `node app.js` 只监听 `127.0.0.1:3000` | 对 DSH 说「分享 3000 端口」 | 手机连同一 WiFi，打开 `http://192.168.x.x:3000` 就能测试 |
| 想让外面的手机也访问 | 「把 8080 也通过公网分享」 | 得到一条 `https://xxx.trycloudflare.com`，任意网络可访问 |
| 同时测好几个服务 | 多次添加即可 | 每个端口独立共享、独立公网 URL |

关键特性：

- **多端口共享**：想分享几个就加几个，互不影响；
- **零配置**：不需要改你的服务代码；服务只绑 `127.0.0.1` 也能被手机访问（自动起 TCP 代理）；
- **自适应直连/代理**：服务已经绑了全部接口 → 直连，不占额外端口；只绑 loopback → 自动起代理（同端口被占自动顺延找空闲端口）；
- **Cloudflare 快速隧道**：`public: true` 即获得公网 URL，cloudflared 二进制自动下载（国内镜像加速）；每端口一条独立隧道；
- **自动恢复**：DSH 重启后按上次配置自动拉起所有共享；
- **看门狗**：目标服务崩溃/隧道进程死亡自动重连，服务后启动也能自动接上。

## 安装

```bash
# 方式一：命令行（web / desktop 二选一，DSH Desktop 用 desktop）
npx @deepseek-ai/dsh plugin --profile desktop add D:\DshWorkspace\dsh-port-share

# 方式二：junction 软链（开发期改代码即时生效，同 dsh-pocket 的 LOCAL-DEV 方案）
New-Item -ItemType Junction `
  -Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-port-share" `
  -Target "D:\DshWorkspace\dsh-port-share"
```

> DSH Desktop 用户：也可以在应用内的插件管理界面添加。装完**重启 dsh web / DSH Desktop** 生效。
> 从 GitHub 安装（发布后）：`dsh plugin --profile desktop add <你的用户名>/dsh-port-share`。

## 使用（直接跟 DSH 说人话）

插件注册了 5 个模型工具（`port_share_*`），模型会自动调用。你也可以显式要求：```text
把 3000 端口分享到局域网
→ 端口 3000：✅ 运行中
  局域网: http://192.168.1.5:3000（TCP 代理 0.0.0.0:3000 → 127.0.0.1:3000）
```

```text
把 8080 端口也通过公网分享
→ 公网: https://abc-123-def.trycloudflare.com
```

```text
现在有哪些端口在共享？
→ port_share_list
```

```text
停掉 3000 的共享
→ port_share_remove { port: 3000 }
```

```text
把 4000 的公网分享关掉，只留局域网
→ port_share_update { port: 4000, public: false }
```

### 工具一览

| 工具 | 参数 | 说明 |
|---|---|---|
| `port_share_add` | `port`（必填）、`host`（默认 `127.0.0.1`）、`name`、`lan`（默认 true）、`public`（默认 false）、`publicPort`（监听端口偏好） | 新增共享 |
| `port_share_list` | — | 列出全部共享及访问地址 |
| `port_share_status` | `port` | 单个共享详情（可达性/URL/运行状态） |
| `port_share_update` | `port`（必填）、`lan`、`public`、`name`、`publicPort` | 修改共享（只改传入字段） |
| `port_share_remove` | `port` | 移除共享 |

### 设置页 UI（图形化配置）

除了对话工具，插件还在 DSH **设置**里注册了一个一级入口 **「端口共享」**（与 dsh-pocket 的「手机访问」同级）：

- **新增共享**：输入端口号（必填）、服务地址（默认 `127.0.0.1`）、备注名，点按胶囊开关选择「局域网 / 公网」，一键添加；
- **共享列表**：每个端口一张卡片，实时显示运行状态（运行中 / 等待服务启动 / 异常）、**局域网地址**、**公网隧道地址**（可直接点开）；
- **管理**：卡片上可直接开关该端口的局域网 / 公网分享（`port_share_update` 等价操作），或一键移除；
- **自动刷新**：列表每 5 秒自动刷新一次，也可手动点「刷新」。

> 设置页 UI 与对话工具操作的是同一份配置（`$DSH_HOME/dsh-port-share/shares.json`），两边实时互通。

## 工作原理

```
手机（局域网）──> http://192.168.x.x:<port> ──┐
                                              ├─► TCP 代理(0.0.0.0) ──► 127.0.0.1:<port>（你的服务）
手机（公网）───> https://xxx.trycloudflare.com ──┘        （或服务已绑全接口 → 直连，无代理）
```

- **局域网**：通用 TCP 代理（`node:net`），HTTP / WebSocket / 任意 TCP 协议原样透传；
- **公网**：`cloudflared tunnel --url http://127.0.0.1:<port>` 快速隧道（强制 HTTP/2 协议，兼容国内网络）。URL 每次重启会变，以 `port_share_list` / `port_share_status` 返回为准；
- **持久化**：配置存 `$DSH_HOME/dsh-port-share/shares.json`，启动自动恢复；
- **状态机**：目标服务不可达时不占端口（避免堵死你之后要启动的服务），服务起来后看门狗自动拉起。

## 配置

| 途径 | 说明 |
|---|---|
| 环境变量 `DSH_PORT_SHARE_CLOUDFLARED` | 指定已有的 cloudflared 可执行文件路径，跳过自动下载 |
| 插件配置 `cloudflaredPath` | 同上（在插件配置里设置） |
| 插件配置 `home` | 自定义状态/缓存目录（默认 `$DSH_HOME`） |

## 安全提示

- 公网隧道把服务暴露给**任何人**——只分享你信任的测试服务，用完记得 `port_share_remove`；
- 快速隧道 URL 是公开的（trycloudflare.com 子域），不要把带敏感数据的服务开公网；
- 局域网分享仅限同一网段（WiFi/内网），Windows 首次监听可能触发防火墙弹窗，请允许「专用网络」访问。

## 故障排查

| 现象 | 原因/处理 |
|---|---|
| 局域网地址打不开 | 手机和电脑要连同一个 WiFi；检查 Windows 防火墙是否放行 Node.js；确认目标服务确实在监听 |
| 公网 URL 显示「未就绪」 | 首次使用会自动下载 cloudflared（约 50MB，国内镜像加速），等一会儿再看 `port_share_status`；若下载失败，手动 `winget install cloudflared` 或设置 `DSH_PORT_SHARE_CLOUDFLARED` |
| 开代理/VPN（Clash TUN 等）时隧道起不来 | TUN 模式会掐断隧道连接，退出代理后重试 |
| 目标服务显示「未启动」 | 服务还没监听该端口（或监听在其他地址），服务起来后 15 秒内自动恢复 |

## 开发

```bash
node test/manager.test.js        # 核心逻辑集成测试（不依赖 DSH 宿主）
node test/web-rpc.test.js        # 设置页 RPC 通道单元测试（envelope/分发/桥接）
node test/client-smoke.test.js   # 客户端 bundle 冒烟测试（槽位注册/接线）
node test/smoke-tunnel.mjs       # cloudflared 下载 + 公网隧道端到端冒烟
```

设置页客户端是**零构建**的：`client/client.js` 即最终产物（手写普通 JS + `window.__ModuleLoader__.load` 包装，同 dsh-pocket 的 client 接入方式），改完无需打包，重启 dsh web / DSH Desktop 生效（junction 软链开发下即时生效）。

## License

MIT
