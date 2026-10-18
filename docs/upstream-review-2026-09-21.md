# DeepSeek Harness 上游更新与 DSH-Mod 评估

## 比较范围

2026-09-21 从官方 `origin` fetch 后，最新 `master` 为 `ddefc45fbc`，对应 `dsh-v0.1.6-alpha.2`（提交时间 2026-09-17）。原运行 checkout 停在 `c291e7961a`，包版本仍为 `0.1.5-rc.2`；两者相差 1548 个提交，计数包含分支合并。

最新代码放在同级 `deepseek-harness-latest/` 的独立 Git worktree，原 `deepseek-harness/` 的 HEAD、未提交修改和启动脚本保留。此处“已拉取”指源码已下载并检出，**运行服务尚未切到 alpha.2**。

## 与当前使用有关的变化

| 范围 | 上游变化与依据 |
|------|----------------|
| 模型 | 多提供商本来就存在；新版本增加模型图片输入选项，调整模型目录，并继续完善 Messages 协议兼容。[图片输入设置](https://github.com/deepseek-ai/deepseek-harness/pull/4334)、[Messages 端点修复](https://github.com/deepseek-ai/deepseek-harness/pull/4241) |
| 文件与文档 | 新增 Office 文档转 PDF 预览、转换缓存，Markdown 文件链接可打开本地预览。[Office 预览](https://github.com/deepseek-ai/deepseek-harness/pull/4041)、[文件链接](https://github.com/deepseek-ai/deepseek-harness/pull/4255) |
| 对话与侧栏 | 新增 Sidebar Browser、子代理侧栏对话、计划卡片和自动预览；上下文用量移至输入框统计区。[浏览器](https://github.com/deepseek-ai/deepseek-harness/pull/4379)、[子代理](https://github.com/deepseek-ai/deepseek-harness/pull/4417)、[计划卡片](https://github.com/deepseek-ai/deepseek-harness/pull/4414) |
| 工作区与开发 | 工作区树、修改差异预览、Web 插件管理、子代理并发设置等。[工作区树](https://github.com/deepseek-ai/deepseek-harness/pull/4273)、[差异预览](https://github.com/deepseek-ai/deepseek-harness/pull/4279)、[Web 插件管理](https://github.com/deepseek-ai/deepseek-harness/pull/3596) |
| Desktop | 自动更新和 Windows 标题栏/菜单等改进。对当前 Web 部署不是直接替代。[Desktop 更新](https://github.com/deepseek-ai/deepseek-harness/pull/4033) |

`@` 的文件搜索、目录下钻和输入框引用预览在当前基线就已存在，不应当作 alpha.2 才新增。最新代码进一步区分文件、直接子代理和其他会话引用。

## 逐项退役结论

| 定制 | 结论 | 依据 |
|------|------|------|
| `#` 文件搜索 | 可按使用习惯关闭；保留兼容开关 | 原生 `@` 覆盖搜索/引用/预览；Mod 仍有插入纯文本绝对路径的区别。本次 `hashFileSearch: false` 可同时停止客户端菜单与服务端扫描 RPC，默认保留。 |
| bundle 对旧 `ui-files` 的禁用 | 已移除 | 普通上游没有该行，会产生无意义 patch 警告。旧 fork 的重复插件由自己的 profile 禁用。 |
| 打开工作区目录 | 保留，可单独关闭 | 原生 Host 有 `session/openWorkspacePath` 能力，但当前审查的 Web 工作区操作没有同等的 Finder/资源管理器入口；Mod 的会话标题栏入口仍有用途。 |
| 网关配对、自动补种浏览器会话、远程配置拦截、连接日志 | 保留 | 上游的浏览器认证与可信 Host 不等价于 Mod 的设备配对和手机受限入口。升级新增 Web 插件管理后，还需核对新增 RPC 是否应归入远程拦截范围。 |
| 通用 RPC 的 webServer fallback | 暂留 | alpha.2 的 `rpc-host.ts` 仍经 `owner.webServer.register` 注册。Mod 先调用官方注册，只在对应注入错误时走 fallback；仅靠源码比较不足以证明真实 profile 已不需要它。 |
| 本体历史回放心跳/分片补丁 | 暂留，升级需迁移 | `packages/api/gateway/src/stream-server.ts` 从当前 HEAD 到最新上游没有变化，本地未提交的分片与心跳代码尚未被这次更新替代。 |
| 本体“刷新文件”文字按钮 | 暂留，升级需迁移与 UI 回归 | 最新预览仍有刷新图标，但未保留本地常驻文字标签。`TextPreview.tsx` 上游也有 Office 等改动，不能直接用旧文件覆盖。关闭文件→修改磁盘→重新打开的实际复现仍需保留。 |
| 自建模型请求层 | 无需新增 | 当前本体已经有 `zai`、`zai-coding-cn`、`moonshotai-cn`、`kimi-coding`；本次在原生模型页的 Kimi、GLM 卡片内提供 Key 检查按钮，调用检查成功后保存模型。协议、流式处理、思考和工具调用由上游适配器负责。 |

## 本次模型接入与验证

按后续需求，配置入口收敛为 Kimi（`api.kimi.com`）和 GLM（`open.bigmodel.cn`），旧四预设命令行助手与 Moonshot 路由已移除。GLM 的开放平台和 Coding Plan 在同一卡片中切换；Kimi 使用国内 Code 入口。[智谱 Coding 入口](https://www.bigmodel.cn/glm-coding?plantype=team)、[Kimi 官方接口](https://www.kimi.com/code/docs/en/)。

设置 → 模型的提供商卡片内输入 Key 后，点击“检查可用性并配置模型”。GLM 沿用现有 `bigmodel` 路由和 Anthropic Coding 接口。Host 提供现有配置及本体目录中的候选模型，每次只检查所选的一个模型；成功后保存该模型并保留原有列表。使用新凭据引用暂存 Key，在设置版本冲突或保存失败时回收。已有默认模型和其他配置不受影响。检查接口被远程网关屏蔽。

测试覆盖固定域名、两类 GLM 端点、单次调用、429 业务错误分类和冷却、认证失败、错误响应、版本冲突回滚、取消、并发、密码框、模型选择、按钮状态和配置结果。原生适配器还通过本地 SSE 验证三个账号组合。没有真实 Key 的厂商在线调用不包含在这些测试内。

alpha.2 worktree 仍只完成源码比对，运行 checkout 和此次集成验证使用 `c291e7961a`。

## 切换运行版本之前

将现有网关心跳/分片和文字刷新按钮逐项迁移到新 worktree，运行对应 Host、预览与 Mod 测试；再用独立 DSH_HOME 验证 profile 启动、两家提供商的三个账号组合和手机网关。核对新增插件管理 RPC 的拦截后再切换启动目录。不要直接在带未提交修复的旧目录执行覆盖更新，也不要把 alpha.2 源码下载完成描述为生产运行已升级。
