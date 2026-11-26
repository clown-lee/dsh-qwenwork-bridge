/**
 * 凭据层的最小验证：读登录态 → 换 MaaS 密钥 → 打一次上游。
 *
 * 跑法（在插件目录下）：
 *   node test/e2e-shim.mjs
 *
 * 它不会打印 token 全文，只打印前缀和长度。
 */

import { QWENWORK_VARIANTS, readQwenworkCredential } from '../lib/credential.js'
import { MaasKeyStore } from '../lib/maas.js'

const variant = QWENWORK_VARIANTS[0]

/** 打码。 */
function mask(value) {
  if (typeof value !== 'string' || value.length === 0) return '(empty)'
  return `${value.slice(0, 12)}… (${String(value.length)} chars)`
}

console.log('variant:', variant.id, variant.displayName)

const read = await readQwenworkCredential(variant, '')
if (read.error !== undefined) {
  console.error('FAIL read credential:', read.error)
  process.exit(1)
}
console.log('appDataDir:', read.appDataDir)
console.log('authFile:', read.authFilePath)
console.log('token:', mask(read.credential.token))
console.log('user:', read.credential.user?.name, read.credential.user?.tier)
console.log('expiresAt:', read.credential.expiresAt)

const keystore = new MaasKeyStore({ gatewayOrigin: variant.gatewayOrigin })
const engine = await keystore.key(read.credential.token)
console.log('engine base url:', engine.baseUrl)
console.log('engine key:', mask(engine.accessToken))
console.log('expires in (min):', Math.round((engine.expiresAtMs - Date.now()) / 60000))

const response = await fetch(`${engine.baseUrl}/v1/chat/completions`, {
  method: 'POST',
  headers: {
    authorization: `Bearer ${engine.accessToken}`,
    'content-type': 'application/json',
  },
  body: JSON.stringify({
    model: 'deepseek-flash',
    stream: false,
    messages: [{ role: 'user', content: '只回四个字：通道正常' }],
  }),
})
console.log('chat status:', response.status)
const text = await response.text()
console.log('chat body:', text.slice(0, 600))
