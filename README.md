# DSH-Mod: Workspace Files & Open-Folder RPC

为 DeepSeek Harness Web 提供两个工作区相关能力的 DSH 插件包：

- **`#` 工作区文件引用**：在会话输入框输入 `#` 后，按当前会话 `cwd`（回退到所属工作区路径）搜索工作区文件；选择候选项后插入 `#相对路径 ` 文本引用。
- **原生打开目录的 RPC 通道**：`/mod-workspace-open` 以 loopback-only 权限把路径交给操作系统的默认打开方式（macOS `open` / Windows `Invoke-Item` / Linux `xdg-open`，WSL 转交 Windows），并提供 `describe` 能力探测。

该包作为 profile bundle 安装：`cordis.patch.yml` 只插入一个 `dsh-mod` 行，Node 半边注册两个基于 `ctx.connection.rpc.handle` 的通用 RPC 通道，浏览器半边通过 `ctx.inputTriggers` 注册 `#` 源。插件不修改 `@deepseek-ai/dsh-host-apiproxy` 的静态 `RpcMethodMap`，也不依赖上游尚未合入的 `host.searchFiles`/`host.openPath`。

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
3. 选择候选项，输入框替换为 `#相对路径 `。

## 布局

| 路径 | 作用 |
|---|---|
| `cordis.patch.yml` | profile patch layer：插入 `dsh-mod` 条目 |
| `lib/index.js` | Host 半边：`/mod-workspace-files` 与 `/mod-workspace-open` RPC 通道 |
| `lib/client.js` | Browser 半边：`#` 触发源（`window.__ModuleLoader__` bundle） |
| `package.json` | `dsh.bundle` + `dsh.client` 声明与导出 |

## 与当前 deepseek-harness fork 的边界

当前 fork 中的两个 commit 还包含上游静态 RPC（`host.searchFiles`、`host.openPath`、`host.describe.canOpenPath`）和 `ui-workspace` 行菜单“在文件管理器中打开”。其中 `#` 文件引用已经可以完全由本插件替代；但 **open-folder 的 UI 入口目前无法在不动 `ui-workspace` 的前提下从外部贡献**（工作区行菜单没有对应的 slot 扩展点）。

建议的上游 seam：在 `ui-workspace` 的工作区行 `...` 菜单声明一个 list slot（例如 `sidebar.workspaces.workspaceRowAction`），由 owner 传入 `{ workspaceId, path }`；随后本插件可以注册一个“在文件管理器中打开”动作，通过 `/mod-workspace-open` 的 `describe` + `open` 完成。未合入前，open-folder UI 暂时保留在 fork 的 `ui-workspace` 补丁中。

## Model Experience

浏览器表现层插件：插入的 `#path` 以普通文本进入用户消息，菜单浏览和 Host 文件搜索不产生模型 token；不改写任何早期请求 token，因此 KV Cache 影响为 append-only。
