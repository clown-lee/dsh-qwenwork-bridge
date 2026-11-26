/**
 * 千问办公账号上下文：积分余额就藏在这里。
 *
 * 客户端每次进主界面都会打这个接口（日志里叫 `account.getContext`），
 * 所以它比任何「猜出来的」额度端点都可靠：
 *
 * ```text
 *   GET {gateway}/api/v1/adapter/user/account-context?include=user,plan,quota,page,data_sharing
 *   → 200 { code: "ok", data: { user, plan, quota: { total, used, remaining, exceeded }, ... } }
 * ```
 *
 * `quota.total` / `quota.used` 在免费版上是 `null`，只有 `remaining` 有值，
 * 所以界面上只报「可用积分」。
 *
 * @module dsh-qwenwork-bridge/balance
 */

/** 客户端自己的版本头；网关对它们做轻校验，缺了不一定会拒绝但保持一致更稳。 */
export const CLIENT_HEADERS = Object.freeze({
  'user-agent': 'qoderwork/2.1.0',
  'x-qwenwork-version': '2.1.0',
  'x-qwenwork-release-version': '2.1.0-26111906',
  'x-qwenwork-build': '26111906',
  'x-qwenwork-platform': 'win32',
  'x-qwenwork-arch': 'x64',
  'x-qwenwork-channel': 'stable',
  'x-qwenwork-app-mode': 'standard',
})

/** 账号上下文的查询串：只取界面要用的几段。 */
const CONTEXT_PATH = '/api/v1/adapter/user/account-context?include=user,plan,quota,page,data_sharing'

/** 取一个有限数；不是数就当没有。 */
function finiteOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * 读一次账号上下文。
 * @param variant - 发行版（提供 `gatewayOrigin`）。
 * @param credential - 解出来的登录凭据。
 * @param signal - 可选中止信号。
 * @returns `{user, plan, quota}`；请求失败时抛错。
 */
export async function fetchAccountContext(variant, credential, signal) {
  const res = await fetch(`${variant.gatewayOrigin}${CONTEXT_PATH}`, {
    method: 'GET',
    headers: {
      ...CLIENT_HEADERS,
      accept: 'application/json',
      authorization: `Bearer ${credential.token}`,
    },
    signal,
  })
  const text = await res.text()
  if (!res.ok) {
    throw new Error(`account-context ${res.status}: ${text.slice(0, 200)}`)
  }
  let body
  try {
    body = JSON.parse(text)
  } catch {
    throw new Error(`account-context returned non-JSON: ${text.slice(0, 200)}`)
  }
  if (body?.code !== undefined && body.code !== 'ok') {
    throw new Error(`account-context code ${String(body.code)}: ${String(body.message ?? '')}`)
  }
  const data = body?.data ?? {}
  const quota = data.quota ?? {}
  return {
    user: {
      name: typeof data.user?.name === 'string' ? data.user.name : '',
      username: typeof data.user?.username === 'string' ? data.user.username : '',
    },
    plan: {
      pid: typeof data.plan?.pid === 'string' ? data.plan.pid : '',
      name: typeof data.plan?.name === 'string' ? data.plan.name : '',
      isSubscribed: data.plan?.is_subscribed === true,
    },
    quota: {
      remaining: finiteOrNull(quota.remaining),
      total: finiteOrNull(quota.total),
      used: finiteOrNull(quota.used),
      exceeded: quota.exceeded === true,
    },
  }
}
