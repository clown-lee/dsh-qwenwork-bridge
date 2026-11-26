/**
 * 本地 shim 的端到端验证：鉴权、`/v1/models`、流式、工具调用、错误映射。
 *
 * 跑法（在插件目录下）：
 *   node test/e2e-local.mjs
 */

import { QWENWORK_VARIANTS, readQwenworkCredential } from '../lib/credential.js'
import { QwenworkCatalog } from '../lib/catalog.js'
import { MaasKeyStore } from '../lib/maas.js'
import { createQwenworkShim } from '../lib/shim.js'

const variant = QWENWORK_VARIANTS[0]
const logger = {
  debug: () => {},
  warn: (message) => console.warn('[warn]', message),
  error: (message, error) => console.error('[error]', message, error?.message ?? ''),
}

const read = await readQwenworkCredential(variant, '')
if (read.error !== undefined) {
  console.error('FAIL read credential:', read.error)
  process.exit(1)
}

const catalog = new QwenworkCatalog()
const keystore = new MaasKeyStore({ gatewayOrigin: variant.gatewayOrigin })
const shim = createQwenworkShim({
  resolveCredential: async () => read,
  keystore,
  catalog,
  logger,
})
await shim.ready

const base = shim.baseUrl()
const auth = { authorization: `Bearer ${shim.token()}` }
let failures = 0

/** 记一条结果。 */
function check(label, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures += 1
}

// 1. 没带 Bearer 必须 401。
{
  const res = await fetch(`${base}/v1/chat/completions`, { method: 'POST', body: '{}' })
  check('missing bearer → 401', res.status === 401, `status=${String(res.status)}`)
}

// 2. /v1/models 返回清单。
{
  const res = await fetch(`${base}/v1/models`, { headers: auth })
  const body = await res.json()
  check('GET /v1/models → 200', res.status === 200, `status=${String(res.status)}`)
  check('/v1/models lists 14 models', body.data?.length === 14, `count=${String(body.data?.length)}`)
  check('/v1/models has deepseek-flash', body.data?.some((m) => m.id === 'deepseek-flash') === true)
}

// 3. 非流式对话。
{
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-flash',
      stream: false,
      messages: [{ role: 'user', content: '只回两个字：收到' }],
    }),
  })
  const body = await res.json().catch(() => ({}))
  check('non-stream chat → 200', res.status === 200, `status=${String(res.status)}`)
  check('non-stream has content', typeof body.choices?.[0]?.message?.content === 'string', JSON.stringify(body.choices?.[0]?.message?.content ?? '').slice(0, 60))
  check('non-stream has reasoning_content', typeof body.choices?.[0]?.message?.reasoning_content === 'string')
}

// 4. 流式对话：必须见到 data: 分片和 [DONE]。
{
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-flash',
      stream: true,
      messages: [{ role: 'user', content: '数一行：1 2 3' }],
    }),
  })
  check('stream chat → 200', res.status === 200, `status=${String(res.status)}`)
  check('stream content-type is event-stream', (res.headers.get('content-type') ?? '').includes('text/event-stream'))
  const text = await res.text()
  check('stream saw "data:" frame', text.includes('data:'))
  check('stream saw [DONE]', text.includes('[DONE]'))
  check('stream has delta content', text.includes('"delta"'))
}

// 5. 工具调用。
{
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-flash',
      stream: false,
      messages: [{ role: 'user', content: '用 get_weather 查一下杭州今天的天气，直接调用工具。' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'get_weather',
            description: '查询指定城市的天气',
            parameters: {
              type: 'object',
              properties: { city: { type: 'string', description: '城市名' } },
              required: ['city'],
            },
          },
        },
      ],
    }),
  })
  const body = await res.json().catch(() => ({}))
  const calls = body.choices?.[0]?.message?.tool_calls
  check('tool call → 200', res.status === 200, `status=${String(res.status)}`)
  check('tool call returned tool_calls', Array.isArray(calls) && calls.length > 0, JSON.stringify(calls ?? null).slice(0, 200))
  check('tool call name is get_weather', calls?.[0]?.function?.name === 'get_weather', String(calls?.[0]?.function?.name))
}

// 6. 未知模型名：上游会拒，状态码必须 ≠ 200 且不是 500。
{
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'no-such-model', messages: [{ role: 'user', content: 'hi' }] }),
  })
  check('unknown model → non-200', res.status !== 200, `status=${String(res.status)}`)
}

// 7. 未知路由。
{
  const res = await fetch(`${base}/v1/nope`, { headers: auth })
  check('unknown route → 404', res.status === 404, `status=${String(res.status)}`)
}

await shim.close()
console.log(failures === 0 ? '\nALL PASSED' : `\n${String(failures)} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
