/**
 * 千问办公的 MaaS 密钥（引擎访问凭据）生命周期。
 *
 * 桌面端的推理不是拿账号 JWT 直接调上游的：它先用 JWT 向网关换一枚短期的
 * "MaaS" 密钥（2 小时 TTL），再用那枚密钥调 `{base_url}/v1/chat/completions`。
 * 签发接口：
 *
 * ```text
 *   POST {gateway}/api/desktop-sessions
 *   Authorization: Bearer <账号 JWT>
 *   {} -> { access_token, base_url, expires_at_ms, ttl_ms, session_id }
 * ```
 *
 * 这里把签发 + 缓存 + 提前续期包成一个 `key()` 调用，shim 每次请求都问它，
 * 所以密钥过期对上层是透明的。
 *
 * @module dsh-qwenwork-bridge/maas
 */

/** 提前多久续期。桌面端源码里的 `REFRESH_BEFORE_EXPIRY_MS` 就是 10 分钟。 */
const REFRESH_BEFORE_EXPIRY_MS = 600_000

/** 签发失败后多久允许重试，避免每个请求都去打网关。 */
const FAILURE_BACKOFF_MS = 30_000

/** 签发请求的默认 UA；服务端会按它识别客户端。 */
const MINT_USER_AGENT = 'qoderwork/2.1.0'

/** 签发路径。 */
const MINT_PATH = '/api/desktop-sessions'

/** 把异常压成一行。 */
function describe(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 一枚已经签发的引擎密钥。
 * @typedef {object} EngineKey
 * @property {string} accessToken - 上游 Bearer。
 * @property {string} baseUrl - 上游根地址，**不含** `/v1`。
 * @property {number} expiresAtMs - 到期时刻。
 */

/**
 * 管理引擎密钥。
 *
 * 一个实例只服务一个账号：JWT 变了（用户重新登录）就整枚作废重签。
 */
export class MaasKeyStore {
  /**
   * @param params.gatewayOrigin - 网关根地址（不带尾斜杠）。
   * @param params.logger - 可选日志。
   */
  constructor({ gatewayOrigin, logger }) {
    this.gatewayOrigin = gatewayOrigin.replace(/\/+$/, '')
    this.logger = logger
    /** @type {EngineKey | undefined} */
    this.current = undefined
    /** 当前密钥绑定的账号 JWT，换了账号就不能复用。 */
    this.boundToken = ''
    /** 上一次签发失败的时刻。 */
    this.failedAtMs = 0
    /** 上一次签发失败的原因。 */
    this.lastError = undefined
    /** 正在进行的签发，避免并发请求各签一枚。 */
    this.inflight = undefined
  }

  /** 现在这枚密钥还能用吗。 */
  #fresh(token) {
    if (this.current === undefined) return false
    if (this.boundToken !== token) return false
    return Date.now() < this.current.expiresAtMs - REFRESH_BEFORE_EXPIRY_MS
  }

  /**
   * 拿一枚可用的密钥，必要时现场签发。
   * @param token - 账号 JWT。
   * @param force - 无视缓存强制重签。
   */
  async key(token, force = false) {
    if (force !== true && this.#fresh(token)) return this.current
    if (force !== true && this.failedAtMs !== 0 && Date.now() - this.failedAtMs < FAILURE_BACKOFF_MS) {
      throw new Error(this.lastError ?? 'engine key unavailable (backing off after a failed mint)')
    }
    if (this.inflight !== undefined) return this.inflight
    const pending = this.#mint(token)
      .then((key) => {
        this.current = key
        this.boundToken = token
        this.failedAtMs = 0
        this.lastError = undefined
        return key
      })
      .catch((error) => {
        this.current = undefined
        this.boundToken = ''
        this.failedAtMs = Date.now()
        this.lastError = describe(error)
        throw error
      })
      .finally(() => {
        this.inflight = undefined
      })
    this.inflight = pending
    return pending
  }

  /** 真的去打签发接口。 */
  async #mint(token) {
    const url = `${this.gatewayOrigin}${MINT_PATH}`
    let response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          accept: 'application/json',
          'user-agent': MINT_USER_AGENT,
        },
        body: '{}',
      })
    } catch (error) {
      throw new Error(`engine key mint request failed: ${describe(error)}`)
    }
    const text = await response.text()
    if (!response.ok) {
      throw new Error(`engine key mint rejected (${String(response.status)}): ${text.slice(0, 400)}`)
    }
    let body
    try {
      body = JSON.parse(text)
    } catch (error) {
      throw new Error(`engine key mint returned non-JSON: ${describe(error)}`)
    }
    const accessToken = body?.access_token
    const baseUrl = body?.base_url
    const expiresAtMs = body?.expires_at_ms
    if (typeof accessToken !== 'string' || accessToken.length === 0) {
      throw new Error('engine key mint returned no access_token')
    }
    if (typeof baseUrl !== 'string' || baseUrl.length === 0) {
      throw new Error('engine key mint returned no base_url')
    }
    const expires = typeof expiresAtMs === 'number' && expiresAtMs > 0
      ? expiresAtMs
      // 缺 expires_at_ms 时按 ttl 推，再退一步给 1 小时。
      : Date.now() + (typeof body?.ttl_ms === 'number' && body.ttl_ms > 0 ? body.ttl_ms : 3_600_000)
    this.logger?.debug?.(`dsh-qwenwork-bridge: minted engine key for ${baseUrl}`)
    return { accessToken, baseUrl: baseUrl.replace(/\/+$/, ''), expiresAtMs: expires }
  }

  /** 状态文档用：不触发签发，只报告手上有什么。 */
  snapshot() {
    return {
      hasKey: this.current !== undefined,
      baseUrl: this.current?.baseUrl ?? '',
      expiresAtMs: this.current?.expiresAtMs ?? 0,
      error: this.lastError,
    }
  }
}
