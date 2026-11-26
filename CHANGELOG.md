# Changelog

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [0.3.0] — 2026-11-26

### 新增

- **每日签到**：启动 8 秒后查一次 `daily-check-in` 状态，命中活动且今天没签就自动领；每个北京日 0 点后重跑一次。
- `lib/checkin.js`：`GET/POST {gateway}/sash/api/v1/me/daily-check-in/{status,claim}`。
- 活动是否开放由千问办公远端配置 `announcement:credits-growth-card` 决定，未投放的账号接口直接 404 —— 这种情况记成 `supported: false` 并静默跳过，不报错。
- 领到积分后立刻让积分角标缓存失效，下一次刷新就是新数字。
- 新路由 `GET /plugins/dsh-qwenwork-bridge/checkin`（`?force=1` 手动触发）。
- 配置项 `autoCheckin`（默认开）。

## [0.2.0] — 2026-11-26

### 新增

- **积分角标**：输入框下方的 dock 里显示当前账号剩余积分，挂在 `conversation.input.dock` 槽位。点击强制刷新，60 秒自动轮询，积分耗尽时变红，读取失败保留旧值并降低透明度。
- `lib/balance.js`：读千问办公自己的账号上下文接口（`account-context` 的 `quota.remaining`），带客户端版本头。
- 新路由 `GET /plugins/dsh-qwenwork-bridge/balance`（`?force=1` 穿透缓存），宿主侧 30 秒缓存。
- `client.js` 浏览器模块，通过 `dsh.client` 段随插件一起加载。

## [0.1.0] — 2026-11-25

首个版本。

### 新增

- 把千问办公（QwenWork）的 14 个内置模型接进 DSH，注册为 `qwenwork` 路由。
- 凭据链：`Local State` 的 DPAPI 保护主密钥 → OSCrypt 解 `auth-v2.dat` 得账号 JWT，主密钥缓存在 `~/.dsh/qwenwork-bridge/storage-key.txt`。
- MaaS 密钥：用 JWT 向 `gateway.qwenwork.cn/api/desktop-sessions` 换 2 小时 TTL 的 `sk-mm-v1.…`，到期前 10 分钟续签，失败 30 秒退避，in-flight 去重。
- 本地回环 shim（`127.0.0.1` 随机端口 + 随机 Bearer + 回环校验），流式原样搬字节。
- 状态码映射：401/403 → 401，402/429 → **402**，404 → 404，≥500 → 502。
- 只读状态路由 `/plugins/dsh-qwenwork-bridge/status` 与 `/refresh`。
