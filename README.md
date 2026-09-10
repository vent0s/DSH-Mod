# DSH-Mod: Workspace Files & Open-Folder RPC & Remote-Access Gateway

为 DeepSeek Harness Web 提供工作区与远程访问能力的 DSH 插件包：

- **远程访问网关（可选）**：DSH 照常只监听 `127.0.0.1:3080`；插件在同一进程内另起一个绑定 `0.0.0.0` 的网关，把 HTTP 与 WebSocket 反代到本体，前置配对码/令牌鉴权。手机（局域网或 Tailscale）打开 `http://<电脑IP>:<网关端口>/mod-gateway/`，输入电脑控制台打印的配对码，即可像在电脑上一样使用 DSH；连接地址可保存在手机本地。详见下文“远程访问网关”。

- **`#` 工作区文件引用**：在会话输入框输入 `#` 后，按当前会话 `cwd`（回退到所属工作区路径）搜索工作区文件；候选项直接显示原生绝对路径（Windows 下为 `盘符:\目录\文件`），选择后把该完整路径插入输入框。（本地适配版：普通 harness 的触发管线只认 `/` 与 `@`，因此本版改为注册到官方 `conversation.input.overlay` 槽，通过 `sessions.provide` 发布的 `useInput`/`inputActions` 读写输入机器状态，`#` 体验不变、不改 harness 本体。）
- **打开工作区目录**：在会话标题栏右侧注册“打开工作区目录”按钮（使用普通 deepseek-harness 自带的 `conversation.session.header.actions` slot，无需修改本体）。点击后在系统文件管理器中打开当前会话所属工作区的目录；仅 loopback 连接、Host 报告可打开、且会话归属某工作区时显示。（工作区行 `⋯` 菜单没有对外扩展点，因此入口放在会话标题栏；侧边栏底部方案见上游版。）
- **原生打开目录的 RPC 通道**：`/mod-workspace-open` 把路径交给操作系统的默认打开方式（macOS `open` / Windows `Invoke-Item` / Linux `xdg-open`，WSL 转交 Windows），并提供 `describe` 能力探测。按钮仅在 loopback 页面显示（`connection.isLoopback`）；0.1.3+ 上游已无按通道的 authority 参数，`/api` 整体由浏览器信任 fence（loopback/`--trusted-host` + 浏览器会话）把守。

该包作为 profile bundle 安装：`cordis.patch.yml` 只插入一个 `dsh-mod` 行，Node 半边注册两个基于 `ctx.connection.rpc.handle` 的通用 RPC 通道；浏览器半边通过官方 `conversation.input.overlay` 槽发布 `#` 文件菜单，并通过 `conversation.session.header.actions` slot 注册“打开工作区目录”动作。插件不触碰上游 `/api` 的 Remote 方法目录（0.1.3+ 为斜杠命名的 `namespace/method` 端点），也不依赖上游的 `fileReferences/list`（`@` 菜单）与 `session/openWorkspacePath`——`#` 插入的是纯文本原生绝对路径，与 `@` 的原子引用芯片互补。

## 安装

仓库是 public，可以直接从 GitHub 安装：

```sh
# <profile> 通常为 web
dsh plugin --profile web add github:vent0s/DSH-Mod
```

本地开发时，在 DSH-Mod 仓库目录执行（CLI 会把相对路径锚定到当前目录）：

```sh
dsh plugin --profile web add .
```

`dsh plugin add` 会把本包写入 profile 的依赖，并根据 package.json 的 `dsh.bundle.patch` 自动把包名追加到 profile 的 bundle 层列表。仓库直接提交 `lib/`，没有 `prepare`/build 步骤，GitHub 安装不需要额外 allowBuilds。

## 使用

1. 启动 Web profile：`dsh --profile web`。
2. 在输入框输入 `#`，继续输入文件名片段。
3. 选择候选项，输入框替换为完整绝对路径，例如 `D:\repo\src\index.ts `。
4. 点击会话标题栏右侧的“打开工作区目录”按钮，即可在系统文件管理器中打开当前会话所属工作区的目录。

## 远程访问网关（可选）

网关默认**不启用**：只有当启动 DSH 的进程导出了 `DSH_MOD_GATEWAY_PORT` 时，插件才会监听。工作区根目录的 `start-dsh.bat` 已内置该开关（并自动把本机各 IPv4 通过 `--trusted-host` 声明给 `/api` 信任 fence）。

**环境变量**（都可选）：

| 变量 | 默认 | 说明 |
|------|------|------|
| `DSH_MOD_GATEWAY_PORT` | 未设置=禁用 | 网关监听端口（如 `3180`） |
| `DSH_MOD_GATEWAY_BIND` | `0.0.0.0` | 监听地址 |
| `DSH_MOD_GATEWAY_TARGET` | `127.0.0.1:$DSH_PORT`(回退 `3080`) | 本体 webserver 地址 |
| `DSH_MOD_GATEWAY_CODE` | 自动生成 | 自定义配对码：可记住的长期密钥，人在外也能给新设备配对；重启后生效 |
| `DSH_MOD_GATEWAY_DIAG` | 未设置=关闭 | 置 `1` 开启排障:向代理的 index.html 注入 `window.__diag` 录制器(console/网络/WS 事件),网关输出 upgrade 时序日志(不记录请求/响应体与 cookie 值) |
| `DSH_HOME` | `~/.dsh` | 状态文件所在目录（与 DSH 本体一致） |

**使用流程**：

1. 电脑：运行 `start-dsh.bat`，在 "DSH Server" 窗口找到 `dsh-mod-gateway ... pairing code:` 行（或在 bat 里设置自己记得住的 `DSH_MOD_GATEWAY_CODE`）。
2. 手机（同一 WiFi 或 Tailscale）：浏览器打开窗口里打印的任一 `http://<IP>:3180/` 地址，进入“DSH 远程控制台”。
3. 输入配对码完成配对，点“进入 DSH”；把该页加入主屏幕即成"App"。**配对一次长期有效**（令牌 1 年，同时备份在手机本地，换 LAN/Tailscale 地址或 cookie 丢失都会自动恢复，不再要码）。配对码按控制台打印的原样输入即可（`XXXX-XXXX` 带连字符）。
4. 首次“进入 DSH”时网关会自动向本体完成浏览器会话补种（见安全模型第 4 层），手机端无需再抄 `dsh web` 打印的 `?token=` 地址；会话 cookie 与配对令牌一样长期有效，过期后下次进入会自动重新补种。
5. 建议把 Tailscale 地址（`http://100.x.x.x:3180/`）作为固定入口存进连接列表——家里家外都是同一个地址，一份配对走天下。
6. 换新手机/清了存储：凭配对码重新配对即可（配对码固定不变，人不在家也能凭记忆输入）。吊销入口用于踢掉所有已配对设备（配对码不变）；怀疑配对码泄露时在电脑上改 `DSH_MOD_GATEWAY_CODE` 并重启。

**安全模型（四层）**：

1. 网关配对/令牌闸：无令牌请求（含 WebSocket upgrade）止步于网关，永不触达本体；令牌只存哈希（`$DSH_HOME/.dsh-mod-gateway.json`），cookie 为 HttpOnly + SameSite=Lax；配对/吊销接口拒绝 `sec-fetch-site: cross-site`，每来源 IP 连续 10 次配对失败锁定 2 分钟。
2. 网关特权方法拦截名单：`settings/*`（除只读 `settings/describe`——DSH Web 客户端启动必需的设置镜像读，缺它侧边栏工作区不加载）、`credentials/*`、`agentPresets/read|copy|deletePreset`、`directoryPicker/*`、`session/openWorkspacePath`、`llm/discoverModels`、`dynamicCordisRunner` 的执行面（`runHostHalf`/`invoke`/`settleUserRun` 等）一律 403——手机能干活，拿不到密钥；设置变更、凭据读写与宿主侧插件执行永不出电脑。方法名使用 deepseek-harness 0.1.3+ 的斜杠 wire 格式（`/api/settings/update`）。**0.1.5 起上游取消了按方法的 loopback 特权层**（任何浏览器会话都能调全部方法），这张名单因此是配置面在远程访问下的**主防线**，而非纵深冗余。
3. 上游 Host fence：反代保留客户端原始 Host，本体继续把远程来源判为非 loopback（`--trusted-host` 只放行普通 RPC），特权方法补种路径仍以 loopback 面目定向转发以兼容未配置 `--trusted-host` 的启动。
4. 上游浏览器会话补种：本体对首页与全部 `/api` 还有一层 launch-token/cookie 会话（cookie 绑定访问的 host:port）。插件把本进程的 launch token 交给网关；已配对设备首次进入遇到 401 时，网关经环回以 `?token=` 代为换取两份会话 cookie（一份绑定手机访问地址、一份绑定 `127.0.0.1:3080` 供第 2 层的 Host 改写请求使用）并随 303 下发给设备。launch token 只在环回链路上出现，不出进程、不经手机。

**网关自管端点**（不经过反代）：

| 路径 | 说明 |
|------|------|
| `GET /mod-gateway/` | 连接管理控制台（配对入口） |
| `GET /mod-gateway/health` | 在线探测（CORS 开放，返回 `{ok,service,name}`） |
| `GET /mod-gateway/state` | 当前来源是否已配对（含 hostId） |
| `POST /mod-gateway/pair` | `{code}` 换令牌（返回 token+hostId 供手机本地备份；配对码不变） |
| `POST /mod-gateway/auth` | `{token}` 令牌换 cookie（跨地址/丢 cookie 静默恢复） |
| `POST /mod-gateway/revoke` | `{code}` 吊销全部令牌（配对码不变） |
| `POST /mod-gateway/rotate` | `{code}` 换新配对码并吊销全部令牌（疑似泄露时用） |

**已知边界**：明文 HTTP（局域网/Tailscale 内使用，勿暴露公网）；手机端无法使用设置/凭据页（有意为之，用电脑访问 `127.0.0.1:3080` 管理）；用 MagicDNS 主机名访问需在启动参数里为该主机名追加 `--trusted-host`。首次手机访问 Windows 防火墙弹窗需放行。


## 布局

| 路径 | 作用 |
|------|------|
| `cordis.patch.yml` | profile patch layer:插入 `dsh-mod` 条目 |
| `lib/index.js` | Host 半边:`/mod-workspace-files` 与 `/mod-workspace-open` RPC 通道;按环境变量启动网关 |
| `lib/gateway.js` | 远程访问网关:0.0.0.0 监听、HTTP/WS 反代、配对/令牌/吊销、连接管理页(未导出环境变量时不加载任何监听) |
| `lib/client.js` | Browser 半边:`#` 文件菜单(`conversation.input.overlay` 槽,本地适配版)+ `conversation.session.header.actions` 打开当前工作区目录动作(`window.__ModuleLoader__` bundle) |
| `package.json` | `dsh.bundle` + `dsh.client` 声明与导出 |

## 开箱即用边界

本包面向**未修改的普通 deepseek-harness**：Host 能力走通用 `ctx.connection.rpc.handle` 通道，文件引用走既有 `ctx.inputTriggers` 的 `#` pipeline，打开工作区目录走普通 harness 已经声明的 `sidebar.footer.action` slot，所以不需要先给 deepseek-harness 打任何补丁。

和 fork 中行菜单版本的区别只是入口位置：普通 harness 的工作区行 `...` 菜单没有对外扩展点，因此本包把“打开目录”放在侧边栏底部（可以列出并打开任意工作区），而不是放在每一行的 `...` 菜单里。若以后上游给 `ui-workspace` 行菜单增加 slot seam，可以再追加一个行内入口。

## Model Experience

浏览器表现层插件：插入的完整绝对路径以普通文本进入用户消息，菜单浏览和 Host 文件搜索不产生模型 token；不改写任何早期请求 token，因此 KV Cache 影响为 append-only。
