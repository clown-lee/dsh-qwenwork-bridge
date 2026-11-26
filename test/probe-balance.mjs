// Verify the balance translation: credential -> account-context -> the shape the
// client chip consumes.
import { QWENWORK_VARIANTS, readQwenworkCredential } from '../lib/credential.js'
import { fetchAccountContext } from '../lib/balance.js'

const variant = QWENWORK_VARIANTS[0]
const read = await readQwenworkCredential(variant)
if (read.error !== undefined) {
  console.error('no credential:', read.error)
  process.exit(1)
}

const context = await fetchAccountContext(variant, read.credential)
console.log(JSON.stringify(context, null, 2))

const remaining = context.quota.remaining
if (typeof remaining !== 'number' || !Number.isFinite(remaining)) {
  console.error('FAIL: quota.remaining is not a finite number')
  process.exit(1)
}
if (remaining <= 0) {
  console.error('FAIL: quota.remaining is not positive')
  process.exit(1)
}
// Mirrors client.js formatCredits.
const shown = remaining.toFixed(2).replace(/\.0+$/, '').replace(/(\.\d)0$/, '$1')
console.log(`\nchip label would read: 积分 ${shown}`)
console.log('PASSED')
