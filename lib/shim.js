/**
 * 本地回环 shim：把 pi-ai 的 OpenAI Completions 请求转给千问办公的上游。
 *
 * 为什么不直接让 pi-ai 打上游：上游要的 Bearer 是一枚 2 小时 TTL 的 MaaS
 * 密钥，pi-ai 的 apiKey 是静态的。所以这里起一个只监听 127.0.0.1 的小服务，
 * 由它在每个请求上现取可用密钥 —— 顺带把 401/额度错误翻译成 pi-ai 认得的形状。
 *
 * 上游本身就是 OpenAI 兼容的，所以这一层**不翻译协议**，只做鉴权注入与错误映射。
 *
 * @module dsh-qwenwork-bridge/shim
 */

import http from 'node:http'
import crypto from 'node:crypto'

/** 请求体上限（字节）。超长上下文 + 图片很容易超过默认值，给 64MB。 */
const MAX_REQUEST_BYTES = 64 * 1024 * 1024

/** 读一个请求体。 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_REQUEST_BYTES) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      resolve(Buffer.concat(chunks))
    })
    req.on('error', reject)
  })
}

/** 写一个 JSON 响应。 */
function writeJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

/** OpenAI 形状的错误体。 */
function writeOpenAiError(res, status, message, type, code) {
  writeJson(res, status, {
    error: { message, type, code: code ?? null, param: null },
  })
}

/**
 * 上游 HTTP 状态 → 该回给 pi-ai 的状态。
 *
 * 402 表示额度用尽（千问办公的套餐额度），pi-ai / 宿主看到 402 + 
 * `insufficient_quota` 会当成永久错误，不会连打 —— 这一点在 trae-bridge 上踩过：
 * 当时 5003 被映射成 429，宿主当可重试软限流连发 5 次，触发了上游的熔断。
 */
function mapUpstreamStatus(status) {
  if (status === 401 || status === 403) return 401
  if (status === 402 || status === 429) return 402
  if (status === 404) return 404
  if (status >= 500) return 502
  return status
}

/** 把上游错误体压成一句话。 */
function describeUpstream(text) {
  const trimmed = text.trim()
  if (trimmed.length === 0) return 'upstream returned an empty error body'
  try {
    const parsed = JSON.parse(trimmed)
    const message = parsed?.error?.message ?? parsed?.message ?? parsed?.error?.code
    if (typeof message === 'string' && message.length > 0) return message
  } catch {
    // 不是 JSON，原样截断。
  }
  return trimmed.slice(0, 400)
}

/**
 * 起一个 shim。
 * @param params.resolveCredential - async () => `{ credential }`，拿账号 JWT。
 * @param params.keystore - `MaasKeyStore`。
 * @param params.catalog - `QwenworkCatalog`。
 * @param params.logger - 可选日志。
 */
export function createQwenworkShim({ resolveCredential, keystore, catalog, logger }) {
  /** 本进程内随机的共享密钥：本地任何别的程序都不该能借用这条通道。 */
  const token = crypto.randomBytes(32).toString('base64url')
  let port = 0

  /** 处理一次 `/v1/chat/completions`。 */
  const handleChat = async (req, res) => {
    let payload
    try {
      const raw = await readBody(req)
      payload = JSON.parse(raw.toString('utf8'))
    } catch (error) {
      writeOpenAiError(res, 400, `invalid request body: ${error instanceof Error ? error.message : String(error)}`, 'invalid_request_error')
      return
    }

    // 模型名上游认的是 `model` 字段，和我们目录里的 id 是同一套，不需要改写。
    const stream = payload?.stream === true

    let engine
    try {
      const { credential } = await resolveCredential()
      engine = await keystore.key(credential.token)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger?.warn?.(`dsh-qwenwork-bridge: engine key unavailable — ${message}`)
      // 密钥拿不到多半是账号态过期，或者套餐不允许 API 访问。
      writeOpenAiError(res, 402, message, 'insufficient_quota', 'engine_key_unavailable')
      return
    }

    let upstream
    try {
      upstream = await fetch(`${engine.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${engine.accessToken}`,
          'content-type': 'application/json',
          accept: stream ? 'text/event-stream' : 'application/json',
          'user-agent': 'qoderwork/2.1.0',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(600_000),
      })
    } catch (error) {
      writeOpenAiError(res, 502, `upstream request failed: ${error instanceof Error ? error.message : String(error)}`, 'upstream_error')
      return
    }

    if (!upstream.ok) {
      const text = await upstream.text().catch(() => '')
      const message = describeUpstream(text)
      const status = mapUpstreamStatus(upstream.status)
      const type = status === 402 ? 'insufficient_quota' : status === 401 ? 'authentication_error' : 'upstream_error'
      logger?.warn?.(`dsh-qwenwork-bridge: upstream ${String(upstream.status)} — ${message}`)
      // 密钥被上游判死（401）时清掉，下一次请求会重签一枚。
      if (upstream.status === 401) keystore.current = undefined
      writeOpenAiError(res, status, message, type, status === 402 ? 'insufficient_quota' : null)
      return
    }

    if (!stream) {
      const text = await upstream.text()
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      })
      res.end(text)
      return
    }

    // 流式：原样把 SSE 字节搬过去。上游的分片本来就是标准 `data: {...}` + `[DONE]`。
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    })
    const body = upstream.body
    if (body === null) {
      res.end()
      return
    }
    const reader = body.getReader()
    /** 客户端提前断开时别再往上游读。 */
    let closed = false
    res.on('close', () => {
      closed = true
      void reader.cancel().catch(() => {})
    })
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done === true || closed) break
        res.write(Buffer.from(value))
      }
    } catch (error) {
      logger?.warn?.(`dsh-qwenwork-bridge: stream aborted — ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      res.end()
    }
  }

  const server = http.createServer((req, res) => {
    // 只认本机回环：别的网卡上来的请求一律不认。
    const remote = req.socket.remoteAddress ?? ''
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) {
      writeOpenAiError(res, 403, 'loopback only', 'invalid_request_error')
      return
    }
    const authorization = req.headers.authorization
    if (authorization !== `Bearer ${token}`) {
      writeOpenAiError(res, 401, 'missing or invalid shim bearer token', 'authentication_error')
      return
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/v1/models' && req.method === 'GET') {
      writeJson(res, 200, {
        object: 'list',
        data: catalog.current().map((model) => ({
          id: model.id,
          object: 'model',
          owned_by: 'qwenwork',
        })),
      })
      return
    }
    if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
      void handleChat(req, res).catch((error) => {
        logger?.error?.('dsh-qwenwork-bridge: shim handler failed', error)
        if (!res.headersSent) {
          writeOpenAiError(res, 500, error instanceof Error ? error.message : String(error), 'internal_error')
        } else {
          res.end()
        }
      })
      return
    }
    writeOpenAiError(res, 404, `no route for ${req.method ?? 'GET'} ${url.pathname}`, 'invalid_request_error')
  })

  /** 监听端口在 `listen(0)` 之后才确定，adapter 建模型描述时要用它。 */
  const ready = new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('shim did not bind a TCP port'))
        return
      }
      port = address.port
      resolve()
    })
  })
  ready.catch((error) => {
    logger?.error?.('dsh-qwenwork-bridge: shim failed to listen', error)
  })

  return {
    /** 绑定完成的信号。 */
    ready,
    /** `http://127.0.0.1:<port>`。 */
    baseUrl() {
      return `http://127.0.0.1:${String(port)}`
    },
    /** 本进程的共享 Bearer。 */
    token() {
      return token
    },
    /** 关掉监听。 */
    close() {
      return new Promise((resolve) => {
        server.close(() => {
          resolve()
        })
        // 有 keep-alive 连接时 close 不会立即回调，这里补一刀。
        server.closeAllConnections?.()
      })
    },
  }
}
