# DSH-Mod: 多模型配置、工作区快捷操作与远程网关

为 DeepSeek Harness Web 提供模型配置、工作区与远程访问能力的 DSH 插件包：

- **多仓库状态**：新会话的工作区选择行右侧提供「仓库」按钮；有聊天内容后，入口在标题栏，以 `✎`、`↑`、`↓` 显示多个仓库的未提交项、待推送和待拉取提交。展开默认只显示仓库名称、分支和状态；通过「管理仓库」填写路径。支持 agent 直接编辑工作区配置，缓存和低频检查控制开销。

- **GLM / Kimi 配置**：本机设置页输入 Key，点击按钮检查模型调用权限，保存可用模型。仅使用 `kimi.com` 和 `bigmodel.cn`。

- **远程访问网关（可选）**：DSH 照常只监听 `127.0.0.1:3080`；插件在同一进程内另起一个绑定 `0.0.0.0` 的网关，把 HTTP 与 WebSocket 反代到本体，前置配对码/令牌鉴权。手机（局域网或 Tailscale）打开 `http://<电脑IP>:<网关端口>/mod-gateway/`，输入电脑控制台打印的配对码，即可像在电脑上一样使用 DSH；连接地址可保存在手机本地。详见下文“远程访问网关”。

- **`#` 工作区文件引用**：在会话输入框输入 `#` 后，按当前会话 `cwd`（回退到所属工作区路径）搜索工作区文件；候选项直接显示原生绝对路径（Windows 下为 `盘符:\目录\文件`），选择后把该完整路径插入输入框。（本地适配版：普通 harness 的触发管线只认 `/` 与 `@`，因此本版改为注册到官方 `conversation.input.overlay` 槽，通过 `sessions.provide` 发布的 `useInput`/`inputActions` 读写输入机器状态，`#` 体验不变、不改 harness 本体。）
- **打开工作区目录**：在会话标题栏右侧注册“打开工作区目录”按钮（使用普通 deepseek-harness 自带的 `conversation.session.header.actions` slot，无需修改本体）。点击后在系统文件管理器中打开当前会话所属工作区的目录；仅 loopback 连接、Host 报告可打开、且会话归属某工作区时显示。（工作区行 `⋯` 菜单没有对外扩展点，因此入口放在会话标题栏；侧边栏底部方案见上游版。）
- **原生打开目录的 RPC 通道**：`/mod-workspace-open` 把路径交给操作系统的默认打开方式（macOS `open` / Windows `Invoke-Item` / Linux `xdg-open`，WSL 转交 Windows），并提供 `describe` 能力探测。按钮仅在 loopback 页面显示（`connection.isLoopback`）；0.1.3+ 上游已无按通道的 authority 参数，`/api` 整体由浏览器信任 fence（loopback/`--trusted-host` + 浏览器会话）把守。

该包作为 profile bundle 安装：`cordis.patch.yml` 只插入一个 `dsh-mod` 行，Node 半边注册四个基于 `ctx.connection.rpc.handle` 的通用 RPC 通道；浏览器半边通过官方 `conversation.input.overlay` 槽发布 `#` 文件菜单，并通过 `conversation.session.header.actions` slot 注册仓库状态和“打开工作区目录”动作。插件不触碰上游 `/api` 的 Remote 方法目录（0.1.3+ 为斜杠命名的 `namespace/method` 端点），也不依赖上游的 `fileReferences/list`（`@` 菜单）与 `session/openWorkspacePath`——`#` 插入的是纯文本原生绝对路径，与 `@` 的原子引用芯片互补。

## 工作区多仓库状态

在新会话中选择工作区，点击工作区、标准模式这一行右侧的 **「仓库 ▾」**。已有聊天内容时，入口在会话标题栏。面板默认显示仓库名称、分支和需要处理的状态，例如 `omenweb · main`、`✎1 未提交`；根仓库显示工作区名称，而不是单独一个 `.`。

点击 **「管理仓库」** 展开路径框，一行填写一个仓库，填好后点击 **「保存」**。尚未配置仓库时直接显示填写框。自动更新远端开关、检查间隔和最近检查时间收在 **「检查设置与时间」** 内。配置保存在**工作区根目录**的 `.dsh-repos.json`，因此 agent 可以填写同一文件，默认每分钟内读取到外部更改。示例：

```json
{
  "version": 1,
  "repos": ["frontend", "backend", "tools/helper"],
  "autoFetch": true,
  "localIntervalSeconds": 60,
  "fetchIntervalSeconds": 300
}
```

工作区本身就是仓库时填写 `.`；路径必须指向工作区内的 Git 根目录，支持嵌套仓库、子模块和 worktree，最多 32 个。拒绝绝对路径、`..`、符号链接越界和普通仓库子目录。不自动递归搜索整个工作区，也不会把备份目录自动纳入。没有配置文件时显示空列表。agent 改写配置后，未编辑的填写框自动同步；如果用户正在编辑，则保留草稿、提示冲突并提供「重新加载配置」，避免覆盖双方的修改。

| 图标 | 含义 |
| --- | --- |
| `✎3` | 3 个未提交项，包括暂存、未暂存和未跟踪内容；同一项只计一次，未跟踪目录聚合为一项 |
| `↑2` / `↓1` | 当前分支相对配置上游领先 2 个 / 落后 1 个提交；分叉时同时显示 |
| `?` | 无上游、分离 HEAD、尚无提交或无法确定差异；详情说明原因 |
| `!` | 仓库读取或远端检查失败，保留可获得的本地计数并提示可能过期 |
| `◷` | 尚未联网核实或远端检查已过期，计数仅供参考 |
| `✓` | 工作树无改动，且与最近检查的上游一致 |

检查只在有可见会话页面时按需执行：本地默认 60 秒，远端默认 300 秒；隐藏页面暂停定时请求。多个页面共享 Host 缓存并合并进行中的请求，最多并行两个 Git 进程；手动刷新本地也保留 5 秒限频。远端失败同样等待完整间隔，手动刷新不会绕过联网冷却。间隔可在 JSON 中调整：本地 30–3600 秒，远端 300–86400 秒。

远端检查使用当前分支上游对应的 `git fetch`，关闭子模块递归、标签获取和自动维护，不执行 pull、merge、push，也不修改工作树。关闭自动检查后仍显示本地已知的上游引用；需要联网更新可重新勾选开关。面板显示本地检查及最近远端成功时间。Git 子进程禁止终端凭据询问，使用已有凭据；本地检查限时 10 秒，fetch 限时 30 秒，输出上限 2 MiB，超时或插件卸载会终止子进程。

入口复用原有的 `conversation.hero.options` 和会话标题栏槽。选择工作区后即可配置，不需要先发消息；尚未选择工作区时不显示。配对的远程页面同样可以查看和填写当前工作区配置。Host 以已注册的工作区 ID 解析目录，不接受客户端指定任意根目录。要整体关闭，在 profile 的 `dsh-mod` 行设置 `repoStatus: false`，同时关闭两个 UI 入口与 `/mod-repos` 通道。

实现跟踪和验收见 [仓库状态跟踪里程碑](devSchedule/仓库状态跟踪/doc/里程碑-仓库状态跟踪.md)。更新本地插件后重启 DSH，并刷新页面加载新版。

## GLM / Kimi：输入 Key，检查并配置模型

打开本机 DSH 的**设置 → 模型**。直接在现有 Kimi、GLM 提供商卡片内输入 Key 并检查，不新增设置导航页：

| 提供商 | 固定域名 | 账号类型 |
|--------|----------|----------|
| Kimi | `api.kimi.com` | Kimi Code，使用 `https://api.kimi.com/coding` 的 Anthropic Messages 接口 |
| GLM | `open.bigmodel.cn` | Coding Plan：`/api/anthropic`；开放平台 API：`/api/paas/v4` |

1. 在对应卡片输入 API Key。GLM 同时选择与 Key 匹配的账号类型；“验证模型”默认选现有配置中的首个模型，也可改选其他候选模型。
2. 点击**检查可用性并配置模型**。每次仅向所选模型发送 **1 次**简短生成请求（`max_tokens: 16`；可关闭思考的模型关闭思考，GLM-5.3 系列使用低强度思考），不扫描整个目录、不自动重试。检查可能消耗少量账号额度。
3. 检查成功后保存 Key、加入所选模型并保留原有模型列表；页面显示本次通过检查的模型，其他模型未在此次检查中验证。Key 输入框会清空，页面不会回读明文密钥。

目录属于已安装的本体；现有手工配置的模型也可选择验证，并保留其上下文大小。新发布且未配置的模型需要先更新本体或在原生模型设置中添加。HTTP 200 的错误对象或模型列表不算调用成功。Key 认证失败、限流、网络错误、取消或所选模型未通过时不覆盖原配置。设置在检查期间被其他页面修改时拒绝覆盖，可重试。

GLM-5.3 系列自动补齐 `Low / High / Max` 思考档位，GLM-5.2 补齐关闭、高、最大三档；已有手工设置优先保留。GLM-5.3 无法关闭思考，未选择档位时沿用服务商默认 `max`。Coding Plan 使用 `output_config.effort`，开放平台使用 `reasoning_effort`；后者在模型级采用本体共享的 `thinking.type` 编码，避免其 `zai` 编码将未选档位误发为关闭思考。其他型号的思考能力仍由原生模型配置设置。档位依据见[智谱思考文档](https://docs.bigmodel.cn/cn/guide/capabilities/thinking)。

GLM 的 HTTP 429 根据[官方业务错误码](https://docs.bigmodel.cn/cn/api/api-code.md)区分账户余额、套餐额度、模型权限、速率限制和服务繁忙。遇到 `Retry-After` 时遵守等待时间；没有该响应头的限流、繁忙或未知 429 默认冷却 60 秒。前端显示倒计时，Host 同样拒绝冷却期内的重复请求。错误正文不会写入日志或显示，只保留数字错误码。

密钥通过本体凭据服务保存，新 Key 使用独立引用暂存，模型设置提交失败则删除暂存引用，已有 Key 和默认模型保持可用。模型配置使用本体设置服务的版本校验与原子写入。本页仅管理 `kimi-coding`、`bigmodel`（沿用现有 GLM 配置）。旧版本的四预设命令行助手和其余提供商入口已移除。

检查控件使用原生 `settings.models.provider-card` 扩展点，Host 通过 `/mod-providers` 处理检查和保存；模型日常请求继续使用原生 `llm-pi-ai` 适配器。地址固定在上述两个官方域名，拒绝重定向，不接受客户端传入其他地址。远程网关屏蔽整个 `/mod-providers` 通道；请在本机页面配置。更新本地插件后重启 DSH，刷新浏览器即可加载该页面。

## 可退役的工作区快捷操作

普通文件引用优先使用本体 `@`：支持文件/目录搜索、Tab 进入目录和点击文件引用预览。`#` 的额外用途是插入**纯文本原生绝对路径**，因此保留为兼容选项，默认仍开启。

要关闭 `#`，在 `$DSH_HOME/profiles/web/cordis.patch.yml` 的 `dsh-mod` 行设置：

```yaml
- id: dsh-mod
  config:
    hashFileSearch: false
    openWorkspaceFolder: true
```

重启 DSH 后生效。`hashFileSearch: false` 同时移除浏览器菜单与文件搜索 RPC；`openWorkspaceFolder: false` 同时移除标题栏动作、能力探测与打开目录 RPC。两个开关均不影响远程网关，也不影响原生 `@`。默认 bundle 已移除针对旧 fork 中 `ui-files` 的禁用补丁；仍使用该 fork 的用户自行在 profile 禁用重复的行。

当前已适配 **DSH 0.2.1-rc.2**；升级内容、验证结果和回退方法见 [2026-10-18 升级记录](docs/upstream-review-2026-10-18.md)。此前每项 Mod 的保留依据见 [2026-09-21 上游评估](docs/upstream-review-2026-09-21.md)。

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
| `DSH_MOD_GATEWAY_DIAG` | 未设置=关闭 | 置 `1` 向代理的 index.html 注入旧版 `window.__diag` 录制器与屏幕面板，仅供临时浏览器排障；服务端文件日志无需开启它 |
| `DSH_MOD_GATEWAY_LOG` | `$DSH_HOME/logs/dsh-mod-gateway.jsonl` | 自动写入服务端连接日志；可设自定义文件路径，设 `0` 关闭。每份 5 MiB，保留当前文件及 `.1`、`.2` 两份历史 |
| `DSH_MOD_GATEWAY_WS_HANDSHAKE_TIMEOUT_MS` | `15000` | 网关等待本体完成 WebSocket HTTP 握手的最长毫秒数；建立后不对空闲连接使用此超时 |
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
2. 网关特权方法拦截名单：`settings/*`（除只读 `settings/describe`——DSH Web 客户端启动必需的设置镜像读，缺它侧边栏工作区不加载）、`credentials/*`、`pluginManager/*`、`configEditor/*`、`deepseekAccount/*`、`agentPresets/read|copy|deletePreset`、`directoryPicker/*`、`session/openWorkspacePath`、`llm/discoverModels`、`dynamicCordisRunner` 的执行面（`runHostHalf`/`invoke`/`settleUserRun` 等）一律 403。前五个命名空间按整体拦截，覆盖新版增加的配置方法；配对设备仍可处理会话。方法名使用 deepseek-harness 0.1.3+ 的斜杠 wire 格式（`/api/settings/update`）。**0.1.5 起上游取消了按方法的 loopback 特权层**（任何浏览器会话都能调全部方法），这张名单因此是配置面在远程访问下的**主防线**，而非纵深冗余。
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

### 连接日志与 Tailscale 排障

启用网关后，服务端默认持续写入 JSONL 日志。更新已安装的本地插件后，需要重启 DSH 进程才会加载新代码。启动时控制台会打印 `diagnostics:` 文件位置。macOS/Linux 可用：

```sh
tail -F "${DSH_HOME:-$HOME/.dsh}/logs/dsh-mod-gateway.jsonl"
```

每行有 UTC 时间 `time`、本次启动标识 `run`；同一请求/连接的事件共用 `id`，`peer` 是直接连接网关的设备地址。默认文件日志不保存请求/响应体、聊天内容、Cookie、Authorization、配对码、URL 查询参数或 WebSocket 消息内容，文件权限为仅当前用户读写。旧版浏览器 `DSH_MOD_GATEWAY_DIAG` 面板是独立的临时排障功能，不属于这份文件日志。

| 事件/字段 | 用途 |
|-----------|------|
| `http.start` / `http.complete` / `http.aborted` | 判断请求是否到达、正常完成或被客户端提前中断；`status` 是网关发给客户端的 HTTP 状态 |
| `upstreamStatus` / `upstreamMs` / `durationMs` | 本体状态、最后一次向本体请求至收到响应头的耗时、网关从收到请求至完成的总耗时；均为毫秒，不能单独当作 Tailscale 往返延迟 |
| `responseKind` / `responseBytes` | 区分 JSON、网页资源和 SSE 长连接，并记录本体响应正文的累计字节数；`/plugins/events` 是热更新通知流，持续数小时后随页面关闭结束属于正常现象 |
| `http.error` / `ws.error` | `side` 区分 client/upstream/session/gateway，`code` 保留 `ECONNRESET`、`ECONNREFUSED` 等错误码 |
| `ws.start` / `ws.handshake` / `ws.rejected` | 追踪连接尝试、本体握手状态（成功为 101）和网关拒绝（例如未配对 401） |
| `ws.closed` | 连接持续时间、最先观测到的断开方向，以及 `handshake_timeout`、`handshake_rejected`、`shutdown` 等原因；方向是观测结果，不等于根因 |
| `gateway.heartbeat` / `ws.sample` | 每 30 秒记录活动 HTTP/WS 数、事件循环延迟、WS 两个方向的累计字节及空闲时间；没有读取 WS 消息内容或新增应用层探测 |
| `clientBufferedBytes` / `upstreamBufferedBytes` | 网关向客户端/本体写入时尚未交给系统的字节数；持续积压有助于区分慢速传输和空闲连接 |
| `log.dropped` | 磁盘写入跟不上流量时的丢弃条数；写入队列有上限，日志故障不会阻塞代理请求 |

WebSocket 两端启用 TCP keepalive；客户端离开、上游报错或插件关闭时会释放隧道两端。文件日志只解释到达网关后的流量，无法证明外部设备的网络正常。

如果通过 Tailscale 访问不稳定，先对比本机网关健康探测、系统路由和 Tailscale 自身连通性。macOS 示例（将 `<对端TailscaleIP>` 替换为实际设备地址）：

```sh
curl --noproxy '*' --max-time 5 http://127.0.0.1:3180/mod-gateway/health
route -n get <对端TailscaleIP>
/Applications/Tailscale.app/Contents/MacOS/Tailscale ping --c 3 --timeout 3s <对端TailscaleIP>
ping -c 3 <对端TailscaleIP>
/Applications/Tailscale.app/Contents/MacOS/Tailscale netcheck
```

若 `tailscale ping` 成功、普通访问失败，且对端 `100.x` 地址走家庭路由器/`en0`，应先检查代理 TUN 是否添加了抢占 `100.64.0.0/10` 的排除路由；目标是让对端地址实际走 Tailscale 接口。仅增加代理 `DIRECT` 规则不能证明路由已正确。可在本机操作时暂停代理 TUN 做对照，再检查路由恢复；远程排障时避免直接切断当前连接。Tailscale 显示已连接也不保证系统数据路径正常，参见 [Tailscale 网络配置排障](https://tailscale.com/docs/reference/troubleshooting/network-configuration)。

本体还会用 WebSocket Ping/Pong 判断掉线，目前默认心跳间隔为 2 秒。如果网络或事件循环会出现数秒停顿，可在 `$DSH_HOME/profiles/web/cordis.patch.yml` 中追加以下条目，重启后提高容忍度（代价是真正断网时判定更慢）。这是本体已有的部署配置，和网关的 **HTTP 握手超时** 是两回事；应结合实际断线日志判断，不能仅凭心跳配置认定根因。

```yaml
- id: typert-gateway
  config:
    websocketHeartbeatIntervalMs: 10000
```

### 回归验证

在本仓库运行 `npm test`；模型配置和功能开关测试也在此命令中。测试仅启动本地临时端口与独立状态目录，覆盖日志轮转/脱敏/写入失败、HTTP 中断、WebSocket 分片握手、握手超时、客户端提前离开、插件加载生命周期及关闭清理，不使用真实配对状态。


原生模型适配器验证：在已安装依赖并构建过的 Harness 源码旁运行 `npm run test:harness`，或用 `DSH_HARNESS_ROOT=/path/to/deepseek-harness npm run test:harness` 指定路径。测试使用该 checkout 的 `tsx`、配置解析器和适配器，Kimi、GLM 的两个账号类型全部指向临时本地 SSE 服务，不使用真实 Key、不连接模型厂商。

UI 交互验证：`npm run test:client` 使用相邻 Harness 的 React 和 JSDOM，检查密码输入、按钮忙碌状态、账号类型切换、失败提示与成功后清空 Key。测试不使用真实密钥。仓库状态用例同时覆盖图标、配置冲突、隐藏页暂停、切换工作区和卸载。

真实浏览器验证：`DSH_HARNESS_ROOT=../deepseek-harness-latest npm run test:repos-browser` 启动隔离的 Web profile、临时 Git 仓库和带内容的测试会话，通过 Chromium 检查实际 RPC、保存配置以及 1280px / 390px 布局。不会读取正式 DSH 的凭据或运行真实模型；结束后清理测试实例。可设置 `DSH_REPO_SCREENSHOTS=/path/to/output` 保留截图。

## 布局

| 路径 | 作用 |
|------|------|
| `cordis.patch.yml` | profile patch layer:插入 `dsh-mod` 条目 |
| `lib/index.js` | Host 半边:工作区快捷操作与 `/mod-providers` 模型配置 RPC 通道;按环境变量启动网关 |
| `lib/gateway.js` | 远程访问网关:0.0.0.0 监听、HTTP/WS 反代、配对/令牌/吊销、连接管理页(未导出环境变量时不加载任何监听) |
| `lib/providers.js` / `lib/provider-manager.js` | 两个固定提供商与先检查后保存的配置流程 |
| `lib/repo-status.js` | 工作区多仓库配置、Git 状态、fetch、缓存、限频及进程池 |
| `lib/diagnostics.js` | 有界异步 JSONL 文件日志、轮转及结构化诊断字段过滤 |
| `lib/client.js` | Browser 半边:原生模型页内的 Key 检查控件、`#` 文件菜单(`conversation.input.overlay` 槽,本地适配版)+ `conversation.session.header.actions` 打开当前工作区目录动作(`window.__ModuleLoader__` bundle) |
| `package.json` | `dsh.bundle` + `dsh.client` 声明与导出 |

## 开箱即用边界

工作区快捷操作使用通用 `ctx.connection.rpc.handle`、`conversation.input.overlay` 和 `conversation.session.header.actions` 扩展点，不要求修改 Harness 本体。模型卡片通过本体设置和凭据服务写入 `llm-pi-ai.providers`，不需要额外挂载模型适配器。远程页面仍受网关的配置面拦截，模型密钥在本机设置页管理。

## Model Experience

浏览器表现层插件：插入的完整绝对路径以普通文本进入用户消息，菜单浏览和 Host 文件搜索不产生模型 token；不改写任何早期请求 token，因此 KV Cache 影响为 append-only。
