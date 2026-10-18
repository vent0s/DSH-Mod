# DSH 0.2.1-rc.2 升级与 Mod 适配记录

## 当前运行状态

2026-10-18 从官方仓库 fetch 后，`origin/master` 和 `dsh-v0.2.1-rc.2` 指向 `687f282e8625c6b8d11ff58211a90524be2e4317`（提交日期 2026-10-17）。相对原运行版本 `c291e7961a` / `0.1.5-rc.2`，包含 5884 个提交，计数包含合并。

- 官方来源：<https://github.com/deepseek-ai/deepseek-harness>
- 新代码：工作区根目录的 `deepseek-harness-latest/`，分支 `mod/upgrade-2026-10-18`。
- 原 `deepseek-harness/` 的 HEAD 和已有未提交修改保留，未 reset、覆盖或提交。
- 根目录 `start-dsh.command` 已指向新目录；启动方式不变。
- 正式服务已经重启为新版本：本机 `127.0.0.1:3080`，Mod 网关 `0.0.0.0:3180`；设置页显示 `0.2.1-rc.2`，网关健康检查返回 200。
- DSH-Mod 继续使用现有本地 profile symlink，保留此前未提交的功能；本次适配也尚未 commit 或 push。

## 本次适配

| 范围 | 变化与处理 |
| --- | --- |
| 设置存储 | 新版移除了 `settings.get()` / `settings-file`。模型管理器改为从 `settings.describe()` 的 `value` 读取当前配置，继续通过 revision 和 `mutate()` 保存。集成测试分别覆盖旧文件存储和新 profile/config-editor 存储。 |
| 模型卡片 | Kimi、GLM 继续使用原生 `settings.models.provider-card` 扩展点和原生 `llm-pi-ai` 适配器；已有模型和密钥引用保留。 |
| 目录按钮 | 适配新版 `IconFolderOpenOutlineRegular`，保留旧版 `IconFolderOpen16` 兼容。`#` 文件菜单和纯文本绝对路径插入继续工作。 |
| 远程网关 | 新增对 `pluginManager`、`configEditor`、`deepseekAccount` 整个命名空间的 HTTP RPC 拦截；`settings`、`credentials` 也按命名空间拦截，保留启动所需的只读 `settings/describe` 例外。`/mod-providers` 仍禁止从网关访问。 |
| 大段历史传输 | 新上游已经完善对排队写入的存活判断，但仍能复现慢读端接收大消息时被心跳断开。迁入 16 KiB 数据帧分片和片间 Ping，保留新版的排队写入存活判断及逻辑消息串行顺序。`websocketFragmentBytes` 可配置，范围 1 KiB–1 MiB。 |
| 文件预览 | 在新版预览工具栏保留常驻“刷新文件”文字；使用上游主题圆角变量。关闭预览、修改磁盘、重新打开的 Markdown/代码/文本/HTML 用例和窄屏可见性已验证。Office 字体警告测试改为比较按钮高度和图标大小，允许文字刷新按钮更宽。 |

## 数据迁移

先在独立 `DSH_HOME` 中启动空 profile，再以原数据的一致性副本启动新版。确认后停止旧服务，完整备份 `~/.dsh`，再启动正式新版本。

新版会把 `settings.yaml` 导入 profile 的 `cordis.patch.yml` 并将原文件保留为 `settings.yaml.imported`；Session 格式也从 v3 演进到 v4。正式迁移后核对：

- `llm-pi-ai` 提供商配置与升级前完全相同。
- `agent-default-model` 配置与升级前完全相同。
- `.credentials.yaml` 的 SHA-256 与升级前一致。
- 浏览器中的工作区列表、Kimi/GLM 已配置模型正常显示。
- 数据副本中的非空旧会话可完整打开；`#package` 搜索并插入实际工作区文件路径成功。

## 验证结果

环境：macOS arm64，Node 26.8.1，仓库指定 pnpm 11.28.5。未发送任何真实模型生成请求。

| 检查 | 结果 |
| --- | --- |
| `pnpm install --frozen-lockfile` | 完成 |
| `pnpm run build:artifacts` / `pnpm run build:check` | 通过；最后一次类型检查在最终测试修改后通过 |
| Mod `npm test` | 45/45 通过 |
| Mod `DSH_HARNESS_ROOT=../deepseek-harness-latest npm run test:client` | 4/4 通过 |
| Mod `DSH_HARNESS_ROOT=../deepseek-harness-latest npm run test:harness` | 4/4 通过：Kimi、GLM 开放平台和 GLM Coding 的实际上游适配器连接本地 SSE 服务；真实设置/凭据服务持久化 |
| Mod `DSH_HARNESS_ROOT=../deepseek-harness npm run test:harness` | 4/4 通过，保留回退到旧本体的兼容性 |
| 网关、主题圆角、预览工具栏定向 Vitest | 4 个文件、99/99 通过，包含大消息慢读回归和配置边界 |
| `pnpm run test:gui` | 初次 10,768 通过、1 跳过、1 失败；唯一失败为迁入按钮使用固定圆角，改成主题变量后相应定向检查通过 |
| 文档预览真实浏览器测试 | 5 个用例通过；第 6 个 Office 用例的旧等宽断言随文字按钮更新后，单独重跑通过。含磁盘更新后重开、手动刷新和 390px 窄屏验证 |
| 实际 Mod 网关 HTTP/WS | 隔离服务配对、会话 cookie 补种、设置只读查询、WebSocket `$events` ready 均通过；设置写入/插件安装/凭据与模型配置入口返回 403 |
| 正式服务 | 新目录进程、3080/3180 监听、版本设置页、模型卡片及健康检查均确认 |
| `git diff --check` | 两个修改仓库均通过 |
| `pnpm run doc-sync` | 42 项通过、1 项上游检查误报，见下文 |

文档检查的唯一失败是 `verify-repository-references` 将未修改的 `python/sdk/uv.lock:113` 中 wheel 文件大小 `6344383` 误当作 Git 提交短 SHA。本地确有以此开头的提交，导致纯数字碰撞；它不是一条仓库引用。本次没有更改官方锁文件或放宽该检查。双语配对、配置目录、文档类型检查和网站构建均已通过。

日志和版本截图保存在工作区根目录的 `upgrade-backup-2026-10-18/`；构建和测试日志在其 `validation/` 子目录。Office/预览截图位于新本体的 `.artifacts/screenshots/0908-document-preview/`。

验证边界：没有调用 Kimi/GLM 的真实付费接口，因此不声称当前账号余额、套餐或实时模型可用性通过验证；手机实体设备与 Tailscale 跨设备链路未实测。本机网关协议和旧会话加载已经验证。

## 备份与回退

`upgrade-backup-2026-10-18/` 权限为仅当前用户访问，包含升级前两个仓库的差异/变更文件、旧启动脚本、停止旧服务后复制的完整 `dsh-home-pre-upgrade/`，以及本次正式服务日志。该目录包含凭据，请作为本机私有备份保存。

回退时必须同时恢复旧启动目录和旧数据；不要让旧本体直接读取已经迁移的数据：

1. 运行根目录的 `stop-dsh.command`。
2. 将当前 `~/.dsh` 移到一个新的备份目录，保留升级后产生的会话；不要删除。
3. 将 `upgrade-backup-2026-10-18/dsh-home-pre-upgrade/` 完整复制回 `~/.dsh`，保留符号链接和权限。
4. 将备份中的 `start-dsh.command` 复制回根目录，运行它启动原 `deepseek-harness/`。

适配后的 Mod 已通过旧本体原生集成测试，通常不需回退 Mod。若要恢复升级前所有 Mod 文件，原始补丁和变更文件归档也在备份中；不要盲目覆盖之后新增的开发工作。
