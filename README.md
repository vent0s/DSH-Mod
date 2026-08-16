# DSH-Mod: Workspace Files & Open-Folder RPC

为 DeepSeek Harness Web 提供两个工作区相关能力的 DSH 插件包：

- **`#` 工作区文件引用**：在会话输入框输入 `#` 后，按当前会话 `cwd`（回退到所属工作区路径）搜索工作区文件；候选项直接显示原生绝对路径（Windows 下为 `盘符:\目录\文件`），选择后把该完整路径插入输入框。（本地适配版：普通 harness 的触发管线只认 `/` 与 `@`，因此本版改为注册到官方 `conversation.input.overlay` 槽，通过 `sessions.provide` 发布的 `useInput`/`inputActions` 读写输入机器状态，`#` 体验不变、不改 harness 本体。）
- **打开工作区目录**：在会话标题栏右侧注册“打开工作区目录”按钮（使用普通 deepseek-harness 自带的 `conversation.session.header.actions` slot，无需修改本体）。点击后在系统文件管理器中打开当前会话所属工作区的目录；仅 loopback 连接、Host 报告可打开、且会话归属某工作区时显示。（工作区行 `⋯` 菜单没有对外扩展点，因此入口放在会话标题栏；侧边栏底部方案见上游版。）
- **原生打开目录的 RPC 通道**：`/mod-workspace-open` 以 loopback-only 权限把路径交给操作系统的默认打开方式（macOS `open` / Windows `Invoke-Item` / Linux `xdg-open`，WSL 转交 Windows），并提供 `describe` 能力探测。

该包作为 profile bundle 安装：`cordis.patch.yml` 只插入一个 `dsh-mod` 行，Node 半边注册两个基于 `ctx.connection.rpc.handle` 的通用 RPC 通道；浏览器半边通过 `ctx.inputTriggers` 注册 `#` 源，并通过原生的 `sidebar.footer.action` slot 注册“打开工作区目录”动作。插件不修改 `@deepseek-ai/dsh-host-apiproxy` 的静态 `RpcMethodMap`，也不依赖上游尚未合入的 `host.searchFiles`/`host.openPath`。

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

## 布局

| 路径 | 作用 |
|---|---|
| `cordis.patch.yml` | profile patch layer：插入 `dsh-mod` 条目 |
| `lib/index.js` | Host 半边：`/mod-workspace-files` 与 `/mod-workspace-open` RPC 通道 |
| `lib/client.js` | Browser 半边：`#` 文件菜单（`conversation.input.overlay` 槽，本地适配版）+ `conversation.session.header.actions` 打开当前工作区目录动作（`window.__ModuleLoader__` bundle） |
| `package.json` | `dsh.bundle` + `dsh.client` 声明与导出 |

## 开箱即用边界

本包面向**未修改的普通 deepseek-harness**：Host 能力走通用 `ctx.connection.rpc.handle` 通道，文件引用走既有 `ctx.inputTriggers` 的 `#` pipeline，打开工作区目录走普通 harness 已经声明的 `sidebar.footer.action` slot，所以不需要先给 deepseek-harness 打任何补丁。

和 fork 中行菜单版本的区别只是入口位置：普通 harness 的工作区行 `...` 菜单没有对外扩展点，因此本包把“打开目录”放在侧边栏底部（可以列出并打开任意工作区），而不是放在每一行的 `...` 菜单里。若以后上游给 `ui-workspace` 行菜单增加 slot seam，可以再追加一个行内入口。

## Model Experience

浏览器表现层插件：插入的完整绝对路径以普通文本进入用户消息，菜单浏览和 Host 文件搜索不产生模型 token；不改写任何早期请求 token，因此 KV Cache 影响为 append-only。
