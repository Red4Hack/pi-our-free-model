import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = path.resolve(__dirname, '..')

export const PROVIDER_ID = 'our-free-model'
export const ENTRY_REL_PATH = 'packages/standalone/cli.mjs'

/** Read by the CLI tools so there is exactly one spelling of the upstream. */
export const UPSTREAM_REPO = 'Ebony-Vinyl/dsh-our-free-model'
export const UPSTREAM_BRANCH = 'main'

/** The gateway's import closure, plus its web assets. Nothing else. */
const SOURCE_PREFIXES = [
  'packages/standalone/cli.mjs',
  'packages/standalone/service.mjs',
  'packages/standalone/management.mjs',
  'packages/standalone/login-terminal.mjs',
  'packages/standalone/eac.mjs',
  'packages/standalone/package.json',
  'packages/standalone/README.md',
  'packages/standalone/channels/',
  'packages/standalone/web/',
  'src/',
  'vendor/channel-pack/qoder-auth-wasm.wasm',
  'vendor/channel-pack/LICENSE',
  'vendor/channel-pack/NOTICE.md',
  'LICENSE',
]
const DENIED_PREFIXES = ['node_modules/', '.git/']

export function isListed(relPath) {
  if (DENIED_PREFIXES.some((prefix) => relPath.startsWith(prefix))) return false
  return SOURCE_PREFIXES.some((prefix) => relPath === prefix || relPath.startsWith(prefix))
}

export function sha256(bytes) {
  // sha256 over a Buffer; kept local so the module has no crypto import whose
  // only use is this.
  return createHash('sha256').update(bytes).digest('hex')
}

/** Data directory for the gateway; independent of any DSH directory. */
export function resolveDataDir() {
  const fromEnv = process.env.PI_OUR_FREE_MODEL_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return path.resolve(fromEnv)
  return path.join(os.homedir(), '.our-free-model')
}

/** Cache root holding one staged snapshot per revision. */
export function resolveCacheRoot() {
  const fromEnv = process.env.PI_OUR_FREE_MODEL_CACHE
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return path.resolve(fromEnv)
  return path.join(resolveDataDir(), 'runtimes')
}

export function snapshotDir(cacheRoot, revision) {
  return path.join(cacheRoot, 'snapshots', revision)
}

/** Where the maintainer-reviewed pin (revision + tree digest) is published. */
export const PIN_URL = 'https://raw.githubusercontent.com/Twofruitsgrape/pi-our-free-model/main/pin.json'

const validPin = (pin) => /^[0-9a-f]{40}$/.test(pin?.revision) && /^[0-9a-f]{64}$/.test(pin?.digest)

/** pin.json: the reviewed upstream revision plus the sha256 of its filtered tree. */
export function readPin() {
  try {
    const pin = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'pin.json'), 'utf8'))
    return validPin(pin) ? { revision: pin.revision, digest: pin.digest } : null
  } catch {
    return null
  }
}

export function parsePin(text) {
  try {
    const pin = JSON.parse(text)
    return validPin(pin) ? { revision: pin.revision, digest: pin.digest } : null
  } catch {
    return null
  }
}
