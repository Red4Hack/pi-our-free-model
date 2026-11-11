import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { isUsableSnapshot } from './snapshot.ts'

/* ==== gateway process management ==== */

/** How long a cold gateway gets to answer /health before we call it failed. */
const HEALTH_TIMEOUT_MS = 60_000
const HEALTH_POLL_MS = 400

export function readSettings(dataDir) {
  try {
    const settingsPath = path.join(dataDir, 'settings.json')
    if (!fs.existsSync(settingsPath)) return undefined
    return JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * Reap a lock whose owner is gone.
 *
 * The gateway opens its lock with `wx`, so the lock file is the authority on who
 * owns the data directory. A process killed by the OS leaves a file that blocks
 * every later start — and after an unclean shutdown that is the most common
 * first-run failure there is.
 *
 * Returns false when the owner is genuinely alive: deleting the lock then would
 * give two gateways one data directory, which is worse than the error.
 */
export function clearStaleLock(dataDir, logger) {
  const lockFile = path.join(dataDir, 'service.lock')
  if (!fs.existsSync(lockFile)) return false
  let ownerAlive = false
  try {
    const parsed = JSON.parse(fs.readFileSync(lockFile, 'utf8'))
    const pid = parsed?.pid
    if (typeof pid === 'number' && pid > 0) {
      try {
        process.kill(pid, 0)
        ownerAlive = pid !== process.pid
      } catch {
        ownerAlive = false
      }
    }
  } catch {
    ownerAlive = false
  }
  if (ownerAlive) return false
  try {
    fs.unlinkSync(lockFile)
    logger?.warn?.('pi-our-free-model: removed a stale service lock from a previous run.')
    return true
  } catch {
    return false
  }
}

async function probeHealth(url, timeoutMs = 1500) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url + '/health', { signal: controller.signal })
    if (!response.ok) return false
    const body = await response.json()
    return body?.service === 'our-free-model-standalone' || body?.service === 'our-free-model'
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = server.address()?.port
      server.close(() => (port ? resolve(port) : reject(new Error('no free port'))))
    })
  })
}

async function waitForHealth(url, child, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let exited = false
  child.once('exit', () => { exited = true })
  while (Date.now() < deadline) {
    if (exited) return false
    if (await probeHealth(url)) return true
    await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_MS))
  }
  return false
}

/**
 * Start, or adopt, the gateway.
 *
 * Adoption is the common path. The gateway outlives pi and already holds a
 * catalog probed from this machine's egress; spawning a second one would waste
 * that work and contend for the data directory lock.
 */
export function ensureService({ cliEntry, dataDir, logger }) {
  return (async () => {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 })
    if (!fs.existsSync(cliEntry)) {
      throw new Error('pi-our-free-model: gateway entry not found at ' + cliEntry + '. Reinstall the package.')
    }

    // A snapshot that exists but failed its completeness check is a partially
    // written cache. Refusing it here is far cheaper than debugging an ENOENT
    // three layers deeper.
    const runtimeRoot = path.resolve(path.dirname(cliEntry), '..', '..')
    if (runtimeRoot.includes(path.join('runtimes', 'snapshots')) && !isUsableSnapshot(runtimeRoot)) {
      throw new Error('pi-our-free-model: cached runtime is incomplete; delete ' + runtimeRoot)
    }

    const settings = readSettings(dataDir)
    const savedKey = settings?.forwardKey
    const savedPort = settings?.standalonePort

    if (typeof savedKey === 'string' && savedKey !== '' && Number.isInteger(savedPort) && savedPort > 0) {
      const existingUrl = 'http://127.0.0.1:' + savedPort
      if (await probeHealth(existingUrl)) {
        return { url: existingUrl, key: savedKey, dataDir, spawned: false, port: savedPort }
      }
    }

    const port = await findFreePort()
    const url = 'http://127.0.0.1:' + port

    // cwd is the gateway's own directory, not the package root: spawning inside
    // node_modules would make the child inherit pi's module resolution.
    const spawnOnce = () =>
      spawn(process.execPath, [cliEntry, '--port', String(port), '--data-dir', dataDir], {
        cwd: path.dirname(cliEntry),
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: { ...process.env, OFM_STANDALONE: '1' },
      })

    let child = spawnOnce()
    child.unref()

    let healthy = await waitForHealth(url, child, HEALTH_TIMEOUT_MS)

    if (!healthy && clearStaleLock(dataDir, logger)) {
      try { child.kill() } catch { /* already dead */ }
      child = spawnOnce()
      child.unref()
      healthy = await waitForHealth(url, child, HEALTH_TIMEOUT_MS)
    }

    if (!healthy) {
      try { child.kill() } catch { /* already dead */ }
      throw new Error('pi-our-free-model: the local gateway did not become healthy on ' + url)
    }

    const finalKey = readSettings(dataDir)?.forwardKey ?? savedKey
    if (!finalKey) throw new Error('pi-our-free-model: could not determine the gateway API key')

    return { url, key: finalKey, dataDir, spawned: true, port }
  })()
}

/**
 * List the gateway's models.
 *
 * Returns undefined rather than [] on failure, because the caller must tell "the
 * gateway has not finished its first catalog refresh" from "the gateway is
 * empty" — only the first should keep waiting.
 */
export async function discoverModels(service, timeoutMs = 20_000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(service.url + '/v1/models', {
      headers: { Authorization: 'Bearer ' + service.key },
      signal: controller.signal,
    })
    if (!response.ok) return undefined
    const body = await response.json()
    if (!Array.isArray(body?.data)) return undefined
    const entries = body.data
      .filter((entry) => typeof entry?.id === 'string' && entry.id !== '')
      .map((entry) => ({
        id: entry.id,
        contextWindow: Number.isFinite(entry.context_window) ? entry.context_window : undefined,
      }))
    return entries.length > 0 ? entries : undefined
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Read the gateway's catalog for metadata /v1/models does not carry.
 *
 * maxOutput, reasoning and vision per model exist nowhere else, and this is one
 * local read rather than N probes.
 */
export function readCatalogMeta(dataDir) {
  const meta = new Map()
  try {
    const catalogPath = path.join(dataDir, 'catalog.json')
    if (!fs.existsSync(catalogPath)) return meta
    const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'))
    for (const row of Array.isArray(catalog?.kiloRows) ? catalog.kiloRows : []) {
      if (typeof row?.id !== 'string') continue
      meta.set(row.id, {
        name: typeof row.name === 'string' ? row.name : undefined,
        contextWindow: Number.isFinite(row.contextWindow) ? row.contextWindow : undefined,
        maxOutput: Number.isFinite(row.maxOutput) ? row.maxOutput : undefined,
        reasoning: row.reasoning !== false,
        vision: row.vision === true,
      })
    }
  } catch {
    /* a catalog written mid-refresh reads as empty; callers have fallbacks */
  }
  return meta
}

/**
 * Wait for the full catalog rather than the first answer.
 *
 * The free lane answers immediately; the account channels report in behind it.
 * Returning on the first response would register ~7 models and hide the other
 * ~650.
 */
export async function waitForFullCatalog(service, { attempts = 15, delayMs = 1000 } = {}) {
  let best
  for (let attempt = 0; attempt < attempts; attempt++) {
    const found = await discoverModels(service, 20_000)
    if (found && found.length > 0) {
      best = found
      if (found.length > 100) return found
    }
    if (attempt < attempts - 1) await new Promise((resolve) => setTimeout(resolve, delayMs))
  }
  return best
}

