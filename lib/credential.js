/**
 * 读取千问办公（QwenWork）桌面端的登录态。
 *
 * 千问办公把账号凭据写在 userData 下的 `auth-v2.dat`，格式是 Electron
 * `safeStorage.encryptString()` 的输出 —— 在 Windows 上也就是 Chromium 那套
 * OSCrypt：
 *
 * ```text
 *   "v10" | 12 字节 nonce | 密文 | 16 字节 GCM tag
 * ```
 *
 * 解它需要 256 位主密钥，主密钥本身被 DPAPI 保护，放在 `Local State` 的
 * `os_crypt.encrypted_key`（Base64，前 5 字节是字面量 "DPAPI"）。
 *
 * Node 没有内置 DPAPI 绑定，所以主密钥这一步借一次 `powershell.exe`
 * （Windows PowerShell 5.1 自带 `ProtectedData`）；解出来的 32 字节主密钥
 * 缓存在插件自己的目录里，之后每次读登录态都只是纯 AES-GCM，不再起子进程。
 *
 * @module dsh-qwenwork-bridge/credential
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'

/** 支持的发行版。目前只有国内版实测过。 */
export const QWENWORK_VARIANTS = Object.freeze([
  Object.freeze({
    id: 'cn',
    displayName: '千问办公',
    /** %APPDATA% 下的目录名。 */
    appDataName: 'QwenWorkCN',
    /** 主服务网关（业务 API + MaaS 密钥签发）。 */
    gatewayOrigin: 'https://gateway.qwenwork.cn',
    /** 兜底的上游推理地址；正常以签发接口返回的 base_url 为准。 */
    fallbackBaseUrl: 'https://api9.qwenwork.cn',
  }),
])

/** DPAPI + AES-GCM 的参数。 */
const GCM_MAGIC = 'v10'
const NONCE_BYTES = 12
const TAG_BYTES = 16
const DPAPI_PREFIX = 'DPAPI'

/** 插件自己的缓存目录，只存解出来的主密钥。 */
function cacheDir() {
  return path.join(os.homedir(), '.dsh', 'qwenwork-bridge')
}

/** 主密钥缓存文件。 */
function keyCachePath() {
  return path.join(cacheDir(), 'storage-key.txt')
}

/** 默认的 userData 目录。 */
export function defaultAppDataDir(variant) {
  const base = process.env.APPDATA
  if (typeof base !== 'string' || base.length === 0) {
    throw new Error('APPDATA is not set; cannot locate the QwenWork user data directory')
  }
  return path.join(base, variant.appDataName)
}

/** 读 `Local State` 里的 DPAPI 保护的密文（Base64 字符串）。 */
function readProtectedKey(localStatePath) {
  let raw
  try {
    raw = fs.readFileSync(localStatePath, 'utf8')
  } catch (error) {
    throw new Error(`cannot read ${localStatePath}: ${describe(error)}`)
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`${localStatePath} is not valid JSON: ${describe(error)}`)
  }
  const encoded = parsed?.os_crypt?.encrypted_key
  if (typeof encoded !== 'string' || encoded.length === 0) {
    throw new Error(`${localStatePath} has no os_crypt.encrypted_key; the app may never have signed in`)
  }
  const blob = Buffer.from(encoded, 'base64')
  if (blob.length <= DPAPI_PREFIX.length) {
    throw new Error('os_crypt.encrypted_key is too short to be a DPAPI blob')
  }
  if (blob.subarray(0, DPAPI_PREFIX.length).toString('latin1') !== DPAPI_PREFIX) {
    throw new Error('os_crypt.encrypted_key is not DPAPI-wrapped; only the Windows backend is supported')
  }
  return blob.subarray(DPAPI_PREFIX.length)
}

/**
 * 用 Windows PowerShell 5.1 的 `ProtectedData` 解开 DPAPI 密文。
 * @param payload - 去掉 "DPAPI" 前缀后的密文。
 * @returns 32 字节主密钥。
 */
function unprotectWithDpapi(payload) {
  const script = [
    '$ErrorActionPreference = "Stop"',
    'Add-Type -AssemblyName System.Security',
    `$b = [Convert]::FromBase64String('${payload.toString('base64')}')`,
    '$k = [System.Security.Cryptography.ProtectedData]::Unprotect($b, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)',
    '[Convert]::ToBase64String($k)',
  ].join('\n')
  // -EncodedCommand 收 UTF-16LE 的 Base64，免掉引号/换行在不同 shell 里的转义差异。
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { timeout: 20_000, windowsHide: true, maxBuffer: 1 << 20 },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(new Error(`DPAPI unprotect failed: ${(stderr || error.message).trim()}`))
          return
        }
        const text = String(stdout).trim()
        const key = Buffer.from(text, 'base64')
        if (key.length !== 32) {
          reject(new Error(`DPAPI unprotect returned ${key.length} bytes, expected 32`))
          return
        }
        resolve(key)
      },
    )
  })
}

/** 读缓存的主密钥；没有就返回 undefined。 */
function readCachedKey() {
  try {
    const text = fs.readFileSync(keyCachePath(), 'utf8').trim()
    const key = Buffer.from(text, 'hex')
    return key.length === 32 ? key : undefined
  } catch {
    return undefined
  }
}

/** 把主密钥写进缓存（只对本用户可读）。 */
function writeCachedKey(key) {
  try {
    fs.mkdirSync(cacheDir(), { recursive: true })
    fs.writeFileSync(keyCachePath(), key.toString('hex'), { mode: 0o600 })
  } catch {
    // 缓存写不进去只影响下一次启动的速度，不影响功能。
  }
}

/**
 * 拿到解 `auth-v2.dat` 用的主密钥：先看缓存，缓存不可用或解不开时再问 DPAPI。
 */
async function resolveStorageKey({ localStatePath, authFilePath }) {
  const cached = readCachedKey()
  if (cached !== undefined) {
    // 缓存有可能是另一个 Windows 用户留下的，用一次真实解密验证它。
    try {
      decryptAuthFile(authFilePath, cached)
      return cached
    } catch {
      // 落到下面重新取。
    }
  }
  const key = await unprotectWithDpapi(readProtectedKey(localStatePath))
  decryptAuthFile(authFilePath, key)
  writeCachedKey(key)
  return key
}

/**
 * 解一条 OSCrypt 密文。
 * @param blob - 完整的文件字节（含 "v10" 前缀）。
 * @param key - 32 字节主密钥。
 */
export function decryptOscrypt(blob, key) {
  if (blob.length < GCM_MAGIC.length + NONCE_BYTES + TAG_BYTES) {
    throw new Error('credential file is too short to be an OSCrypt payload')
  }
  const magic = blob.subarray(0, GCM_MAGIC.length).toString('latin1')
  if (magic !== GCM_MAGIC) {
    throw new Error(`unsupported credential envelope "${magic}"; expected "${GCM_MAGIC}"`)
  }
  const nonce = blob.subarray(GCM_MAGIC.length, GCM_MAGIC.length + NONCE_BYTES)
  const body = blob.subarray(GCM_MAGIC.length + NONCE_BYTES)
  const cipher = body.subarray(0, body.length - TAG_BYTES)
  const tag = body.subarray(body.length - TAG_BYTES)
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(cipher), decipher.final()])
}

/** 解 `auth-v2.dat` 并解析成对象。 */
function decryptAuthFile(filePath, key) {
  const blob = fs.readFileSync(filePath)
  const plain = decryptOscrypt(blob, key).toString('utf8')
  try {
    return JSON.parse(plain)
  } catch (error) {
    throw new Error(`credential JSON is malformed: ${describe(error)}`)
  }
}

/** 把异常压成一行说明。 */
function describe(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 读一次千问办公的登录态。
 *
 * 返回 `{ credential, appDataDir, authFilePath }`，或 `{ error }`。永远不抛。
 * @param variant - `QWENWORK_VARIANTS` 里的一项。
 * @param appDataDirOverride - 显式指定的 userData 目录。
 */
export async function readQwenworkCredential(variant, appDataDirOverride) {
  let appDataDir
  try {
    appDataDir = appDataDirOverride !== undefined && appDataDirOverride !== ''
      ? appDataDirOverride
      : defaultAppDataDir(variant)
  } catch (error) {
    return { error: describe(error) }
  }
  const authFilePath = path.join(appDataDir, 'auth-v2.dat')
  if (!fs.existsSync(authFilePath)) {
    return { error: `${variant.displayName} is not signed in (no auth-v2.dat)`, appDataDir }
  }
  try {
    const key = await resolveStorageKey({
      localStatePath: path.join(appDataDir, 'Local State'),
      authFilePath,
    })
    const credential = decryptAuthFile(authFilePath, key)
    const token = credential?.token
    if (typeof token !== 'string' || token.length === 0) {
      return { error: 'auth-v2.dat has no access token', appDataDir }
    }
    return { credential, appDataDir, authFilePath }
  } catch (error) {
    return { error: describe(error), appDataDir }
  }
}

/** 从 JWT 的 payload 里读过期时间（秒）；读不出来返回 undefined。 */
export function tokenExpirySeconds(token) {
  const parts = token.split('.')
  if (parts.length < 2) return undefined
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    return typeof payload.exp === 'number' ? payload.exp : undefined
  } catch {
    return undefined
  }
}
