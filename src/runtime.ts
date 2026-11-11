import fs from 'node:fs'
import path from 'node:path'
import { PIN_URL, parsePin, readPin, resolveCacheRoot, snapshotDir } from './config.ts'
import { fetchUpstream, isUsableSnapshot, stageSnapshot, treeDigest, verifyClosure } from './snapshot.ts'

/* ==== runtime resolution ==== */

/**
 * Find a usable cached gateway: the auto-update pointer first, then the pin.
 * Returns null when neither is cached; ensureRuntime downloads the pin then.
 */
export function resolveRuntime({ cacheRoot, ignorePointer = false } = {}) {
  const pin = readPin()
  const root = cacheRoot ?? resolveCacheRoot()
  const pointer = ignorePointer ? null : readPointer(root)
  for (const revision of [pointer, pin?.revision]) {
    if (!revision) continue
    const cached = snapshotDir(root, revision)
    if (isUsableSnapshot(cached, { deep: false })) {
      return { root: cached, source: 'cache', revision, fromPointer: revision === pointer && revision !== pin.revision }
    }
  }
  return null
}

export async function ensureRuntime(options = {}) {
  const found = resolveRuntime(options)
  if (found) return found
  const pin = readPin()
  if (!pin) throw new Error('pin.json is missing or invalid')
  const result = await materializeRevision(pin.revision, pin.digest, { cacheRoot: options.cacheRoot })
  if (!result.ok) throw new Error(`could not download gateway ${pin.revision.slice(0, 10)}: ${result.error}`)
  return { root: result.target, source: 'downloaded', revision: pin.revision, fromPointer: false }
}

/** `current.json` names the newest staged revision; it wins over pin.json. */
export function readPointer(cacheRoot) {
  try {
    const revision = JSON.parse(fs.readFileSync(path.join(cacheRoot, 'current.json'), 'utf8'))?.revision
    return /^[0-9a-f]{7,40}$/.test(revision) ? revision : null
  } catch {
    return null
  }
}

export function clearPointer(cacheRoot) {
  fs.rmSync(path.join(cacheRoot, 'current.json'), { force: true })
}

export function writePointer(cacheRoot, revision) {
  fs.mkdirSync(cacheRoot, { recursive: true })
  fs.writeFileSync(path.join(cacheRoot, 'current.json'), JSON.stringify({ revision }) + '\n')
}

/** The published pin on this repo's main; null on any failure. */
export async function fetchLatestPin() {
  const response = await fetch(PIN_URL, { signal: AbortSignal.timeout(8000) }).catch(() => null)
  return response?.ok ? parsePin(await response.text()) : null
}

/** At most once a day, in the background; opt out with PI_OUR_FREE_MODEL_AUTOUPDATE=0. */
export async function autoUpdate(runtime, logger) {
  if (process.env.PI_OUR_FREE_MODEL_AUTOUPDATE === '0') return
  const root = resolveCacheRoot()
  const stamp = path.join(root, 'last-check')
  try { if (Date.now() - fs.statSync(stamp).mtimeMs < 864e5) return } catch { /* never checked */ }
  fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(stamp, '')
  const latest = await fetchLatestPin()
  if (!latest || latest.revision === runtime.revision) return
  if ((await materializeRevision(latest.revision, latest.digest, { logger })).ok) writePointer(root, latest.revision)
}

/**
 * Pull a revision into the cache, accepting it only if its filtered tree hashes
 * to the digest published in pin.json. A mismatch stages nothing.
 */
export async function materializeRevision(revision, digest, { cacheRoot, fetchImpl = fetch, logger } = {}) {
  const root = cacheRoot ?? resolveCacheRoot()
  try {
    const files = await fetchUpstream(revision, { fetchImpl })
    if (treeDigest(files) !== digest) throw new Error(`digest mismatch for ${revision.slice(0, 10)}`)
    const closure = verifyClosure(files)
    if (!closure.ok) {
      throw new Error(`upstream ${revision} is not self-contained: ${closure.problems.slice(0, 3).join('; ')}`)
    }
    const staged = stageSnapshot(root, revision, files)
    logger?.info?.(`pi-our-free-model: staged upstream ${revision.slice(0, 10)} (${closure.fileCount} files)`)
    return { ok: true, target: staged.target, changed: staged.changed, revision, fileCount: closure.fileCount }
  } catch (error) {
    logger?.warn?.(`pi-our-free-model: could not materialize ${revision.slice(0, 10)}: ${error.message}`)
    return { ok: false, error: error.message }
  }
}

