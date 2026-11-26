# dsh-qwenwork-bridge

把 **[千问办公](https://qwenwork.cn)（QwenWork）桌面端自带的模型**接进 [DeepSeek Harness](https://github.com/deepseek-ai) 的模型选择器。装完重启，选择器里就会出现一个「千问办公」分组，**输入框下面还会多一枚积分角标**。

复用千问办公自己的登录态 —— 不需要 API Key，不需要额外登录，也不复制 token 到别处。

<p align="center">
  <img src="assets/icon-180.png" width="88" alt="dsh-qwenwork-bridge">
</p>

| | |
|---|---|
| 平台 | Windows（主密钥走 Windows DPAPI） |
| 宿主 | DSH `^0.2.2-rc.3` |
| 依赖 | 无第三方运行时依赖 |
| 许可 | MIT |

## 快速开始

```sh
dsh plugin --profile desktop add github:clown-lee/dsh-qwenwork-bridge
```

或在 DSH 插件页 →「添加插件」→ 粘贴 `github:clown-lee/dsh-qwenwork-bridge`。装完在插件页把 **DSH 千问办公 Bridge** 打开，然后**重启 DSH**；模型选择器里就会出现「千问办公」分组。

> 用上面那条 `dsh plugin` 命令装的时候只装依赖，不会自动启用；启用这一步在插件页点一下即可。用市场页安装则两者一起做完。

前置：本机已安装并**已登录**千问办公桌面端（`%APPDATA%\QwenWorkCN`）。没登录时分组不显示，登录后最多等 30 秒。

## 接入的模型

| 模型 | 上游 id | 倍率 |
| --- | --- | --- |
| Flash | `flash` | 0.1 |
| Pro | `pro` | 1.0 |
| Qwen4-Max | `qwen4-max` | 1.6 |
| Qwen3.8-Max | `qwen3.8-max-preview` | 1.8 |
| Qwen3.8-Flash | `qwen3.8-flash` | 0.1 |
| GLM-5.4 | `glm-5.4` | 1.2 |
| Ling-3.1-Flash | `ling-3.1-flash` | 0.1 |
| DeepSeek-V4.1-Flash | `deepseek-flash` | 0.1 |
| DeepSeek-V4-Pro | `deepseek-v4-pro` | 0.2 |
| GLM-5.3 | `glm-5.3` | 1.2 |
| GLM-5.3-Flash | `glm-5.3-flash` | 0.2 |
| Kimi-K3.1-Pro | `kimi-k3.1-pro` | 2.4 |
| MiniMax-M3.1-Flash | `minimax-m3.1-flash` | 0.2 |
| Step-5-Preview | `step-5-preview` | 0.7 |

全部模型上下文窗口 100 万 token，原生支持流式输出、工具调用与图片输入，思考过程以 `reasoning_content` 原样透传。

## 积分角标

输入框下方的 dock 里会显示当前账号还剩多少积分，就在上下文指示器那一带：

```text
积分 2073.75
```

- 点击立即刷新，另有 60 秒自动轮询（上游侧 30 秒缓存，不会频繁打上游）
- 悬停显示套餐名与完整数值
- 积分耗尽时数字变红
- 读取失败时保留上一次的值并降低透明度，不会突然清空

数据来自千问办公客户端自己用的账号上下文接口（`account-context` 的 `quota.remaining`），和 App 里看到的数字是同一个来源。

## 每日签到

千问办公的签到现在是**运营活动**：只有远端下发了 `announcement:credits-growth-card` 且 `checkinEnabled: true` 的账号才有入口，接口对其他人直接 404。所以插件这样处理：

- 启动 8 秒后查一次状态，命中活动且今天没签就自动领；每个北京日 0 点后重跑
- 没有活动（`supported: false`）就静默跳过 —— 这不是故障
- 领到积分后积分角标会立刻去查新数字
- 手动触发：`GET /plugins/dsh-qwenwork-bridge/checkin`（`?force=1` 跳过本地记忆）
- 关掉：配置项 `autoCheckin: false`

如果你在千问办公里从来没看到过「签到」，那就是这个账号没有活动，插件也不会空转。

## 它是怎么工作的

```text
  DSH 模型选择器
       │  pi-ai / openai-completions
       ▼
  本地回环 shim（127.0.0.1，随机 Bearer）      ← 每个请求现取一枚短期密钥
       │  POST {engine}/v1/chat/completions
       ▼
  千问办公上游
```

1. **读登录态**：从 `%APPDATA%\QwenWorkCN\auth-v2.dat` 解出账号 JWT。那个文件是 Electron `safeStorage` 的输出，格式是 Chromium OSCrypt：`v10` 前缀 + AES-256-GCM；主密钥被 DPAPI 保护在 `Local State` 的 `os_crypt.encrypted_key` 里。插件借用一次 `powershell.exe` 的 `ProtectedData` 把主密钥解出来，之后缓存在 `~/.dsh/qwenwork-bridge/storage-key.txt`，不再起子进程。
2. **换引擎密钥**：桌面端的推理不是拿账号 JWT 直接调的，而是先用 JWT 向 `https://gateway.qwenwork.cn/api/desktop-sessions` 换一枚 2 小时 TTL 的 MaaS 密钥（`sk-mm-v1.…`）。插件照做，并在到期前 10 分钟自动续期，失败有 30 秒退避。
3. **转发**：上游本身就是 OpenAI 兼容接口，所以 shim 不翻译协议，只注入 `Authorization` 并把上游的 401/402/429 映射成 pi-ai 认得的形状。

登录态每次要发请求才现读，所以你在千问办公里退出或重新登录之后，下一次对话立刻生效，不用重启 DSH。

## 配置

| 项 | 默认 | 说明 |
| --- | --- | --- |
| `userDataDir` | 空 | 千问办公的 userData 目录；留空用 `%APPDATA%\QwenWorkCN`。装在别的盘或用了绿色版才需要填。 |
| `refreshCatalogOnStart` | `true` | 启动时验证一次登录态并预签引擎密钥。 |

## 状态与排错

只读的本地路由（仅回环可访问）：

- `GET /plugins/dsh-qwenwork-bridge/status` — 登录态、引擎密钥、模型清单
- `GET /plugins/dsh-qwenwork-bridge/refresh` — 强制重签一次引擎密钥并刷新状态
- `GET /plugins/dsh-qwenwork-bridge/balance` — 积分余额（`?force=1` 穿透 30 秒缓存）

常见错误：

| 现象 | 原因 |
| --- | --- |
| 选择器里没有「千问办公」分组 | 插件没启用，或 DSH 没重启 |
| 状态里 `signedIn: false` | 千问办公没登录；登录后最多等 30 秒 |
| 对话报 402 `engine_key_unavailable` | 账号套餐不允许 API 端点（免费版常见），或者登录态过期 |
| 对话报 402 `insufficient_quota` | 额度用完了 |
| 积分角标一直转圈 | 千问办公没登录，或 `userDataDir` 指错了 |

## 已知限制

- **只支持 Windows**：主密钥那一步依赖 DPAPI；macOS 的 Keychain 分支没有实现。
- **免费版可能拿不到通道**：实测本机账号能签发密钥并正常对话，但如果你的套餐把「API 端点」权限关掉了，签发会被拒。
- **模型清单是内置快照**：上游没有 `GET /v1/models`（实测 404），清单来自桌面端的 `chat-modes-v2` 目录响应。千问办公更新模型之后，需要跟着改 `lib/catalog.js` 里的 `BUILTIN_MODELS`。
- **没有独立计费信息**：这些模型走订阅额度，`cost` 一律报 0。

## 隐私

| 读什么 | 为什么 |
|---|---|
| `%APPDATA%\QwenWorkCN\auth-v2.dat` | 账号 JWT |
| `%APPDATA%\QwenWorkCN\Local State` | DPAPI 保护的 OSCrypt 主密钥 |
| `~/.dsh/qwenwork-bridge/storage-key.txt` | 缓存解出来的主密钥（仅本机，明文） |

只请求 `gateway.qwenwork.cn` 与签发结果里的引擎地址（如 `api9.qwenwork.cn`）。不联网上报、不修改 App 自己的文件。

## 免责声明

本项目只是把本机已登录的桌面应用接到自己的 agent 上，不对任何服务条款的适用性负责。请自行确认这样使用符合千问办公的用户协议。

本项目与阿里云、通义千问、千问办公、DeepSeek 均无关联，未获其授权或认可；文中出现的名称仅用于描述兼容关系，商标权利归各自所有。

## 许可

MIT
