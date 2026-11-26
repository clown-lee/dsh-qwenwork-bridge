/**
 * 千问办公的「每日签到」。
 *
 * 客户端里这块叫 credits growth card（积分成长卡），由远端配置
 * `announcement:credits-growth-card` 下发，只有命中了运营活动的账号才会看见入口。
 * 对应接口（`app.asar` 里 `DAILY_CHECK_IN_*_PATH`）：
 *
 * ```text
 *   GET  {gateway}/sash/api/v1/me/daily-check-in/status
 *   POST {gateway}/sash/api/v1/me/daily-check-in/claim
 * ```
 *
 * 两个前提必须一起成立，否则客户端自己也不会发请求：
 *
 * 1. 远端下发了活动配置，且 `checkinEnabled: true`
 * 2. 账号没在今天签过（`checkedIn: false`）
 *
 * 实测（2026-11 免费版账号）：配置里这条是 `null`，网关对 `/sash/...` 一律 404，
 * 所以本模块把「端点不存在 / 活动未投放」统一归成 `supported: false`，调用方
 * 静默跳过即可 —— 这不是故障，只是没有活动可参加。
 *
 * @module dsh-qwenwork-bridge/checkin
 */

import { CLIENT_HEADERS } from './balance.js'

const STATUS_PATH = '/sash/api/v1/me/daily-check-in/status'
const CLAIM_PATH = '/sash/api/v1/me/daily-check-in/claim'

/** 北京时间的日期键，例如 `20261126`（签到按北京日切换）。 */
export function beijingDayKey(nowMs = Date.now()) {
  const shifted = new Date(nowMs + 8 * 3600 * 1000)
  const year = shifted.getUTCFullYear()
  const month = String(shifted.getUTCMonth() + 1).padStart(2, '0')
  const day = String(shifted.getUTCDate()).padStart(2, '0')
  return `${year}${month}${day}`
}

/** 距离下一个北京日 0 点还有多少毫秒。 */
export function msUntilNextBeijingMidnight(nowMs = Date.now()) {
  const shifted = new Date(nowMs + 8 * 3600 * 1000)
  const next = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate() + 1, 0, 0, 5)
  return Math.max(1000, next - 8 * 3600 * 1000 - nowMs)
}

/** 一个有限数；不是数就当没有。 */
function finiteOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** 从响应里挖 `data`（客户端会先 unwrap 一层）。 */
function unwrap(body) {
  if (body === null || typeof body !== 'object') return {}
  return body.data !== null && typeof body.data === 'object' ? body.data : body
}

/** 发一次请求，返回 `{status, body, text}`。 */
async function request(variant, credential, path, method, signal) {
  const response = await fetch(`${variant.gatewayOrigin}${path}`, {
    method,
    headers: {
      ...CLIENT_HEADERS,
      accept: 'application/json',
      'content-type': 'application/json',
      authorization: `Bearer ${credential.token}`,
    },
    ...(method === 'POST' ? { body: '{}' } : {}),
    ...(signal === undefined ? {} : { signal }),
  })
  const text = await response.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    body = undefined
  }
  return { status: response.status, body, text }
}

/**
 * 把 status 响应归一化。
 *
 * 客户端解析出的 `dailyCheckIn` 至少带 `status`（`AVAILABLE` / `CLAIMED` /
 * `DISABLED`），这里同时兼容 `checkedIn` / `claimed` 两种命名。
 * @param body - 响应 JSON。
 */
export function normalizeCheckinStatus(body) {
  const data = unwrap(body)
  const checkin = data.dailyCheckIn ?? data.daily_check_in ?? data
  const status = typeof checkin.status === 'string' ? checkin.status : ''
  const checkedIn = checkin.checkedIn === true || checkin.checked_in === true || status === 'CLAIMED'
  return {
    enable: status !== 'DISABLED',
    checkedIn,
    status,
    reward: finiteOrNull(checkin.reward ?? checkin.rewardCredits ?? checkin.reward_credits),
    credits: finiteOrNull(checkin.credits ?? data.credits),
    message: typeof checkin.message === 'string' ? checkin.message : '',
  }
}

/**
 * 查今天的签到状态。
 * @returns `{supported, enable, checkedIn, status, reward, credits, message}`；
 *   `supported: false` 表示这个账号没有签到活动（端点 404 / 配置未下发）。
 */
export async function fetchCheckinStatus(variant, credential, signal) {
  const { status, body, text } = await request(variant, credential, STATUS_PATH, 'GET', signal)
  if (status === 404) return { supported: false, enable: false, checkedIn: false, status: 'ABSENT', reward: null, credits: null, message: 'no check-in campaign' }
  if (status === 401 || status === 403) return { supported: false, enable: false, checkedIn: false, status: 'UNAUTHORIZED', reward: null, credits: null, message: `sign-in expired (${status})` }
  if (status < 200 || status >= 300) throw new Error(`checkin status ${status}: ${text.slice(0, 200)}`)
  return { supported: true, ...normalizeCheckinStatus(body) }
}

/**
 * 领取今天的签到奖励。
 * @returns `{supported, ok, message, reward}`。
 */
export async function claimCheckin(variant, credential, signal) {
  const { status, body, text } = await request(variant, credential, CLAIM_PATH, 'POST', signal)
  if (status === 404) return { supported: false, ok: false, message: 'no check-in campaign', reward: null }
  if (status < 200 || status >= 300) throw new Error(`checkin claim ${status}: ${text.slice(0, 200)}`)
  const data = unwrap(body)
  const claim = data.dailyCheckInClaim ?? data.daily_check_in_claim ?? data
  const reward = finiteOrNull(claim.rewardCredits ?? claim.reward_credits ?? claim.reward)
  const ok = claim.success === true || claim.claimed === true || reward !== null
  return {
    supported: true,
    ok,
    message: typeof claim.message === 'string' ? claim.message : '',
    reward,
  }
}
