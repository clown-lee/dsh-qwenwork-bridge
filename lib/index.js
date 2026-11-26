/**
 * dsh-qwenwork-bridge：把「千问办公」（QwenWork）自带的模型接进 DeepSeek Harness。
 *
 * 数据流：
 *
 * ```text
 *   DSH 模型选择器
 *        │  pi-ai openai-completions
 *        ▼
 *   本地回环 shim（127.0.0.1，随机 Bearer）      ← 每个请求现取一枚 MaaS 密钥
 *        │  POST {engine}/v1/chat/completions
 *        ▼
 *   千问办公上游（用本机 App 的登录态换的短期密钥）
 * ```
 *
 * 登录态不复制、不落盘：每次要用才读千问办公自己的 `auth-v2.dat`（OSCrypt
 * 加密），解出来只在本进程内存里用。
 *
 * @module dsh-qwenwork-bridge
 */

import z from '@deepseek-ai/schemastery'
import { createProvider } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import { QWENWORK_VARIANTS, readQwenworkCredential } from './credential.js'
import { QwenworkCatalog } from './catalog.js'
import { MaasKeyStore } from './maas.js'
import { createQwenworkShim } from './shim.js'
import { fetchAccountContext } from './balance.js'
import { claimCheckin, fetchCheckinStatus, msUntilNextBeijingMidnight } from './checkin.js'

/** 插件自己的名字，用于日志前缀。 */
export const name = 'llm-qwenwork'

/** 只有拿到 LLM 服务才能注册路由。 */
export const inject = ['llm']

/** 一个流读取的最长空转时间。 */
const STREAM_IDLE_TIMEOUT_MS = 300_000

/** 未登录时多久重读一次本机登录态（毫秒）。 */
const CREDENTIAL_POLL_MS = 30_000

/** 积分余额的缓存时长（毫秒）。 */
const BALANCE_TTL_MS = 30_000

/** 图片预算取 dsh-llm-pi-ai 的默认值。 */
const REQUEST_IMAGE_BUDGETS = {
  maxRequestImageBytes: 20_971_520,
  maxRequestImages: 50,
  imageOffloadCountQuantum: 10,
  requestImagePixelBudget: 4_194_304,
  requestImageMaxBytes: 1_048_576,
}

/**
 * 惰性 auth 面：这条路由只靠 shim 的共享密钥，pi-ai 自己的凭据生命周期与
 * 环境探测必须什么都造不出来。
 */
const INERT_AUTH = {
  credentials: {
    async read() {},
    async list() {
      return []
    },
    async modify() {
      throw new Error('dsh-qwenwork-bridge: the qwenwork route has no pi-ai credential lifecycle')
    },
    async delete() {},
  },
  authContext: {
    async env() {},
    async fileExists() {
      return false
    },
  },
}

/** 订阅额度没有可算的单价，报 0。 */
const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

/** 插件配置。 */
export const Config = z.object({
  userDataDir: z.string().default('').volatile().description("千问办公的 userData 目录（默认取 %APPDATA%\\QwenWorkCN）"),
  refreshCatalogOnStart: z.boolean().default(true).volatile().description('启动时验证一次登录态并预签引擎密钥'),
  autoCheckin: z.boolean().default(true).volatile().description('每日自动领取签到积分（账号有活动时才生效）'),
})

/** 读当前配置的普通对象。 */
function configOf(refs) {
  return {
    userDataDir: refs.userDataDir?.get() ?? '',
    refreshCatalogOnStart: refs.refreshCatalogOnStart?.get() ?? true,
    autoCheckin: refs.autoCheckin?.get() ?? true,
  }
}

/** 把一条目录条目翻成 pi-ai 的模型描述。 */
function toPiModel(info, baseUrl, providerId) {
  return {
    id: info.id,
    name: info.name,
    api: 'openai-completions',
    provider: providerId,
    baseUrl,
    input: info.input,
    // 上游确实会吐 `reasoning_content`，但 `reasoning_effort` 档位没有验证过，
    // 所以不声明可调档位 —— 否则选择器会出现一个可能无效的控件。
    reasoning: false,
    cost: NO_COST,
    contextWindow: info.contextWindow,
    maxTokens: info.maxTokens,
    compat: { maxTokensField: 'max_tokens' },
  }
}

/**
 * 组装一条路由的 pi-ai provider 与 adapter。
 * @param params.providerId - 路由名（模型选择器里的分组 key）。
 * @param params.displayName - 分组显示名。
 * @param params.catalog - 模型目录。
 * @param params.shim - 回环 shim。
 */
function createQwenworkAdapter({ providerId, displayName, catalog, shim }) {
  const buildModels = () => {
    const baseUrl = `${shim.baseUrl()}/v1`
    return catalog.current().map((info) => toPiModel(info, baseUrl, providerId))
  }
  const provider = {
    ...createProvider({
      id: providerId,
      name: displayName,
      auth: {
        apiKey: {
          name: '千问办公 shim bearer',
          async resolve({ credential }) {
            const apiKey = credential?.key
            return apiKey === undefined || apiKey.length === 0
              ? undefined
              : { auth: { apiKey }, source: 'QwenWork' }
          },
        },
      },
      models: buildModels(),
      api: openAICompletionsApi(),
    }),
    getModels: () => buildModels(),
  }
  const profile = {
    provider: providerId,
    displayName,
    streamIdleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
    retryPolicy: resolveRetryPolicy(undefined, 'dsh-qwenwork-bridge retryPolicy'),
    configuredMaxTokens: new Map(),
    modelErrors: new Map(),
    ...REQUEST_IMAGE_BUDGETS,
    piProvider: provider,
  }
  const profiles = new Map([[providerId, profile]])
  return {
    adapter: new PiAiAdapter({
      profiles: () => profiles,
      auth: INERT_AUTH,
      resolveApiKey: async () => shim.token(),
    }),
  }
}

/**
 * 一个发行版的运行时。
 *
 * 凭据是**惰性**读的：每次要发请求才现读 App 的 `auth-v2.dat`，所以用户在
 * 千问办公里重新登录之后，下一次对话立刻生效，不需要重启 DSH。
 * @param params.variant - 目标发行版。
 * @param params.config - 读当前配置的函数。
 * @param params.logger - 日志。
 */
function createVariantRuntime({ variant, config, logger }) {
  const providerId = 'qwenwork'
  const displayName = variant.displayName
  const catalog = new QwenworkCatalog(logger)
  const keystore = new MaasKeyStore({ gatewayOrigin: variant.gatewayOrigin, logger })
  /** 最近一次读到的凭据快照。 */
  let snapshot
  /** 最近一次读取失败的原因。 */
  let lastError
  /** adapter 是否已经注册进 LLM seam。 */
  let registered = false
  /** 构造/注册阶段的失败；与「未登录」分开记。 */
  let adapterError
  /** 最近一次刷新尝试的结果。 */
  let lastRefresh
  /** 积分余额缓存：界面角标会定时读，别把上游打爆。 */
  let balanceCache
  let balanceAtMs = 0
  /** 最近一次签到尝试的结果。 */
  let checkinState = {
    atMs: 0,
    /** 这个账号到底有没有「每日签到」活动（由远端配置决定，不是所有账号都有）。 */
    supported: null,
    enable: false,
    checkedIn: false,
    claimed: false,
    reward: null,
    message: '',
    error: '',
  }
  /** 跨天定时与重试句柄。 */
  let checkinTimer
  let checkinRetryTimer

  /** 重新读一次本机登录态（异步：DPAPI 那步可能要起一次 powershell）。 */
  const reload = async () => {
    const wasSignedIn = snapshot !== undefined
    const read = await readQwenworkCredential(variant, configuredDir(config(), variant))
    if (read.error !== undefined) {
      snapshot = undefined
      lastError = read.error
      if (wasSignedIn) {
        // 登出了：把模型退回内置清单的同时也丢掉引擎密钥。
        keystore.current = undefined
        catalog.reset()
      }
      return false
    }
    snapshot = read
    lastError = undefined
    return true
  }

  /** 供 shim 用的凭据解析。 */
  const resolveCredentials = async () => {
    const ok = await reload()
    if (!ok) throw new Error(lastError ?? `${displayName} is not signed in`)
    return snapshot
  }

  const shim = createQwenworkShim({
    resolveCredential: resolveCredentials,
    keystore,
    catalog,
    logger,
  })

  /** 验证一次登录态并预签引擎密钥。 */
  const refreshCatalog = async (force) => {
    const ok = await reload()
    if (!ok) {
      lastRefresh = { at: Date.now(), skipped: lastError ?? 'not signed in' }
      return false
    }
    try {
      const engine = await keystore.key(snapshot.credential.token, force === true)
      lastRefresh = { at: Date.now(), ok: true, baseUrl: engine.baseUrl, expiresAtMs: engine.expiresAtMs }
      return false // 内置清单没变，选择器不需要重读
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      catalog.fail(error)
      lastRefresh = { at: Date.now(), error: message }
      throw error
    }
  }

  /**
   * 跑一次签到。
   *
   * 千问办公的签到是运营活动：只有远端下发了 `announcement:credits-growth-card`
   * 且 `checkinEnabled: true` 的账号才会有，接口对其他人直接 404。所以这里把
   * 「没有活动」当成正常结果记下来，不抛错、不刷日志。
   * @param params.force - 忽略本地记忆重新问一遍。
   */
  const runCheckin = async ({ force = false } = {}) => {
    if (force === false && checkinState.supported === false) return checkinState
    const ok = await reload()
    if (!ok) {
      checkinState = { ...checkinState, atMs: Date.now(), error: lastError ?? `${displayName} is not signed in` }
      return checkinState
    }
    try {
      const status = await fetchCheckinStatus(variant, snapshot.credential)
      let next = {
        ...checkinState,
        atMs: Date.now(),
        supported: status.supported,
        enable: status.enable,
        checkedIn: status.checkedIn,
        reward: status.reward,
        message: status.message,
        claimed: false,
        error: '',
      }
      if (status.supported && status.enable && status.checkedIn === false) {
        const claim = await claimCheckin(variant, snapshot.credential)
        next = {
          ...next,
          supported: claim.supported,
          claimed: claim.ok,
          reward: claim.reward ?? next.reward,
          message: claim.message || next.message,
        }
      }
      checkinState = next
      if (checkinState.claimed) {
        // 领到积分了：角标缓存作废，下次读就是新数字。
        balanceAtMs = 0
        balanceCache = undefined
      }
      return checkinState
    } catch (error) {
      checkinState = {
        ...checkinState,
        atMs: Date.now(),
        error: error instanceof Error ? error.message : String(error),
      }
      return checkinState
    }
  }

  /** 排下一个北京日 0 点之后的签到。 */
  const scheduleCheckin = () => {
    checkinTimer = setTimeout(() => {
      checkinTimer = undefined
      void runCheckin({ force: true }).catch(() => {})
      scheduleCheckin()
    }, msUntilNextBeijingMidnight())
    checkinTimer.unref?.()
  }

  /** 启动 8 秒后补一次，然后改成跨天定时。 */
  const startCheckin = () => {
    checkinTimer = setTimeout(() => {
      checkinTimer = undefined
      void runCheckin().catch(() => {})
      scheduleCheckin()
    }, 8_000)
    checkinTimer.unref?.()
  }

  /** 卸载时清掉定时。 */
  const stopCheckin = () => {
    if (checkinTimer !== undefined) clearTimeout(checkinTimer)
    if (checkinRetryTimer !== undefined) clearTimeout(checkinRetryTimer)
    checkinTimer = undefined
    checkinRetryTimer = undefined
  }

  return {
    variant,
    providerId,
    displayName,
    catalog,
    keystore,
    shim,
    reload,
    refreshCatalog,
    runCheckin,
    startCheckin,
    stopCheckin,
    /**
     * 读一次积分余额。
     *
     * 界面上的角标会定时刷新，直接每次打上游太浪费，所以缓存 `BALANCE_TTL_MS`；
     * 用户点刷新时传 `force` 穿透缓存。
     * @param force - 是否跳过缓存。
     */
    readBalance: async (force) => {
      if (force !== true && balanceCache !== undefined && Date.now() - balanceAtMs < BALANCE_TTL_MS) {
        return balanceCache
      }
      const ok = await reload()
      if (!ok) throw new Error(lastError ?? `${displayName} is not signed in`)
      const context = await fetchAccountContext(variant, snapshot.credential)
      balanceCache = { ...context, fetchedAtMs: Date.now() }
      balanceAtMs = Date.now()
      return balanceCache
    },
    /** 构造/注册阶段捕获到的失败。 */
    setFailure: (error) => {
      adapterError = error instanceof Error ? `adapter: ${error.message}` : `adapter: ${String(error)}`
    },
    /** 标记 adapter 已注册。 */
    markRegistered: () => {
      registered = true
    },
    /** 状态文档：只读快照，不阻塞在 DPAPI 上。 */
    status: () => ({
      variant: variant.id,
      providerId,
      displayName,
      registered,
      signedIn: snapshot !== undefined,
      userName: snapshot?.credential?.user?.name ?? '',
      tier: snapshot?.credential?.user?.tier ?? '',
      expiresAt: snapshot?.credential?.expiresAt ?? '',
      appDataDir: snapshot?.appDataDir ?? '',
      error: lastError,
      adapterError,
      engineKey: keystore.snapshot(),
      lastRefresh,
      checkin: checkinState,
      catalogSource: catalog.source,
      catalogError: catalog.error,
      models: catalog.current().map((model) => ({ id: model.id, name: model.name })),
    }),
  }
}

/** 该发行版在配置里对应的目录。 */
function configuredDir(config, variant) {
  void variant
  const value = config.userDataDir
  return value === '' ? undefined : value
}

/**
 * 插件入口。
 * @param ctx - Cordis 上下文。
 * @param refs - 配置引用。
 */
export async function apply(ctx, refs) {
  const config = () => configOf(refs)
  const logger = ctx.logger
  const runtime = createVariantRuntime({ variant: QWENWORK_VARIANTS[0], config, logger })
  const timers = []
  const cleanups = []

  /** 目录变了就让选择器重读一遍。 */
  const publish = () => {
    ctx.emit('llm/adapters-updated')
  }

  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => {
      const dispose = webCtx.webServer.register({
        kind: 'exact',
        path: '/plugins/dsh-qwenwork-bridge/status',
        handler: (req, res) => {
          if (req.method !== 'GET') {
            writeJson(res, 405, { error: 'method-not-allowed' })
            return
          }
          if (!isTrustedLoopback(req)) {
            writeJson(res, 403, { error: 'request-not-trusted' })
            return
          }
          writeJson(res, 200, runtime.status())
        },
      })
      return () => {
        dispose()
      }
    }, 'dsh-qwenwork-bridge: status route')
    webCtx.effect(() => {
      const dispose = webCtx.webServer.register({
        kind: 'exact',
        path: '/plugins/dsh-qwenwork-bridge/refresh',
        handler: (req, res) => {
          // 宿主的 webServer 只把 GET 派发给 exact 路由，所以刷新走 GET。
          if (req.method !== 'GET') {
            writeJson(res, 405, { error: 'method-not-allowed' })
            return
          }
          if (!isTrustedLoopback(req)) {
            writeJson(res, 403, { error: 'request-not-trusted' })
            return
          }
          runtime.refreshCatalog(true)
            .then(() => {
              writeJson(res, 200, runtime.status())
            })
            .catch((error) => {
              writeJson(res, 200, {
                ...runtime.status(),
                refreshError: error instanceof Error ? error.message : String(error),
              })
            })
        },
      })
      return () => {
        dispose()
      }
    }, 'dsh-qwenwork-bridge: refresh route')
    webCtx.effect(() => {
      const dispose = webCtx.webServer.register({
        kind: 'exact',
        path: '/plugins/dsh-qwenwork-bridge/balance',
        handler: (req, res) => {
          // 客户端的积分角标走这条：GET（exact 路由只派发 GET）+ `?force=1` 穿透缓存。
          if (req.method !== 'GET') {
            writeJson(res, 405, { error: 'method-not-allowed' })
            return
          }
          if (!isTrustedLoopback(req)) {
            writeJson(res, 403, { error: 'request-not-trusted' })
            return
          }
          const force = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('force') === '1'
          runtime.readBalance(force)
            .then((balance) => {
              writeJson(res, 200, balance)
            })
            .catch((error) => {
              writeJson(res, 200, {
                error: error instanceof Error ? error.message : String(error),
                signedIn: runtime.status().signedIn,
              })
            })
        },
      })
      return () => {
        dispose()
      }
    }, 'dsh-qwenwork-bridge: balance route')
    webCtx.effect(() => {
      const dispose = webCtx.webServer.register({
        kind: 'exact',
        path: '/plugins/dsh-qwenwork-bridge/checkin',
        handler: (req, res) => {
          if (req.method !== 'GET') {
            writeJson(res, 405, { error: 'method-not-allowed' })
            return
          }
          if (!isTrustedLoopback(req)) {
            writeJson(res, 403, { error: 'request-not-trusted' })
            return
          }
          const force = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('force') === '1'
          runtime.runCheckin({ force })
            .then((state) => {
              writeJson(res, 200, { checkin: state })
            })
            .catch((error) => {
              writeJson(res, 200, { error: error instanceof Error ? error.message : String(error) })
            })
        },
      })
      return () => {
        dispose()
      }
    }, 'dsh-qwenwork-bridge: checkin route')
  })

  // shim 的监听端口在 `listen(0)` 之后才确定，adapter 建模型描述时要用它拼
  // baseUrl，所以必须等绑定完成再构造。
  await runtime.shim.ready
  let adapter
  try {
    adapter = createQwenworkAdapter({
      providerId: runtime.providerId,
      displayName: runtime.displayName,
      catalog: runtime.catalog,
      shim: runtime.shim,
    })
  } catch (error) {
    logger?.error?.('dsh-qwenwork-bridge: adapter construction failed', error)
    runtime.setFailure(error)
    return
  }
  try {
    const release = ctx.llm.registerAdapter([runtime.providerId], adapter.adapter)
    cleanups.push(() => {
      try {
        release()
      } catch {
        // 卸载阶段的失败不该再抛回宿主。
      }
      void runtime.shim.close()
    })
  } catch (error) {
    logger?.error?.('dsh-qwenwork-bridge: provider registration failed', error)
    runtime.setFailure(error)
    void runtime.shim.close()
    return
  }
  runtime.markRegistered()

  // 每日签到：有活动就领，没有就静默跳过（见 lib/checkin.js 的说明）。
  if (config().autoCheckin !== false) runtime.startCheckin()

  /** 先读一次登录态，让选择器尽快有机会拿到模型。 */
  void runtime.reload().then((ok) => {
    if (ok) publish()
  }).catch(() => {})

  if (config().refreshCatalogOnStart !== false) {
    void runtime.refreshCatalog(false).catch((error) => {
      logger?.warn?.('dsh-qwenwork-bridge: startup refresh failed', error)
    })
  }

  // 「先开 DSH 再登录千问办公」也要能看见模型，所以未登录时按固定间隔重扫。
  const timer = setInterval(() => {
    if (runtime.status().signedIn) return
    void runtime.reload()
      .then((ok) => {
        if (ok) publish()
      })
      .catch(() => {})
  }, CREDENTIAL_POLL_MS)
  timer.unref?.()
  timers.push(timer)

  ctx.effect(() => () => {
    for (const entry of timers) clearInterval(entry)
    runtime.stopCheckin()
    for (const cleanup of cleanups) cleanup()
  }, 'dsh-qwenwork-bridge: teardown')
}

/** 请求是否来自本机浏览器。 */
function isTrustedLoopback(req) {
  const host = req.headers.host
  if (typeof host !== 'string') return false
  const hostname = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0]
  if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(hostname.toLowerCase())) return false
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    return ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(new URL(origin).hostname.toLowerCase())
  } catch {
    return false
  }
}

/** 写一个 JSON 响应。 */
function writeJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(payload),
  })
  res.end(payload)
}
