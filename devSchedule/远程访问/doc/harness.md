# 远程访问 — Harness(DSH-Mod 脱敏同步版)

> 完整版(含真机调试实录)在私有外层仓库。回归脚本在外层仓库 `tests/`,不随本包发布。

## 不变量

1. 本体 webserver 永远只监听 `127.0.0.1:<DSH_PORT>`;一切远程流量必经网关。
2. 无有效令牌的请求(含 WS upgrade)永不到达本体的 `/api`。
3. 转发不重写 Host(唯一例外:`settings.describe` 豁免以 loopback 面目定向转发);特权 RPC(凭据/设置变更/预设管理等)对远程恒 403——密钥不出电脑。
4. 令牌只在配对/换发后有效;配对码固定,`/mod-gateway/rotate` 才轮换并连带吊销。
5. 连接信息只存手机本地。

## 自动化

- `tests/gateway-smoke.mjs`(无需 DSH,临时目录):health/state/pair/auth/revoke/rotate、特权拦截、settings.describe 豁免、502 路径等 17 项。
- `tests/gateway-e2e.mjs`(需 DSH 在跑):**自建 3199 独立网关实例**指向真实上游,不碰用户在用的网关与配对状态;覆盖 S1(模拟)/S2/S3(服务端)/S4(双层拦截+豁免)/S6(health)/S8(吊销)。

## 待真机

S1 真机对话、S3 重开免输、S5 离线恢复、S6 错误地址文案、S7 Tailscale;以及阶段三未解的 events.host 建连问题(实验清单见里程碑)。
