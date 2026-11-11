import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { PROVIDER_ID, resolveCacheRoot, resolveDataDir, snapshotDir } from './config.ts'
import { ensureService, waitForFullCatalog } from './gateway.ts'
import { t } from './messages.ts'
import { buildEarlyConfig, buildProviderConfig } from './models.ts'
import { autoUpdate, clearPointer, ensureRuntime, fetchLatestPin, materializeRevision, writePointer } from './runtime.ts'
import { cliEntryOf, webAssetsOf } from './snapshot.ts'

function openBrowser(url) {
  const [cmd, args] = process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
    : [process.platform === 'darwin' ? 'open' : 'xdg-open', [url]]
  spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref()
}

async function load(ignorePointer = false) {
  const runtime = await ensureRuntime({ ignorePointer })
  return { runtime, cliEntry: cliEntryOf(runtime.root), assets: webAssetsOf(runtime.root) }
}

export default function registerOurFreeModel(pi) {
  const logger = {
    debug: (message) => pi.logger?.debug?.(message),
    info: (message) => pi.logger?.info?.(message),
    warn: (message) => pi.logger?.warn?.(message),
  }
  const dataDir = resolveDataDir()

  let state
  // Register from saved settings + last catalog right away, so /model and --model work
  // before the gateway answers; boot() replaces it with the live list.
  const early = buildEarlyConfig(dataDir)
  if (early) pi.registerProvider(PROVIDER_ID, early)

  let ready = null
  const boot = () => {
    ready ??= (async () => {
      state = await load()
      let running
      try {
        running = await ensureService({ cliEntry: state.cliEntry, dataDir, logger })
      } catch (error) {
        if (!state.runtime.fromPointer) throw error
        logger.warn(t.rollback(state.runtime.revision))
        clearPointer(resolveCacheRoot())
        state = await load(true)
        running = await ensureService({ cliEntry: state.cliEntry, dataDir, logger })
      }
      const config = await buildProviderConfig(running, logger)
      pi.registerProvider(PROVIDER_ID, config)
      logger.info(
        `pi-our-free-model: ${config.models.length} model(s) via ${config.baseUrl} ` +
        `(gateway ${state.runtime.source} @ ${String(state.runtime.revision).slice(0, 10)}, ${state.assets.length} web assets)`,
      )

      // The free lane answers first and the account channels report in behind it.
      if (config.models.length < 50) {
        setTimeout(async () => {
          try {
            const full = await waitForFullCatalog(running)
            if (full && full.length > config.models.length) {
              const topped = await buildProviderConfig(running, logger, { preloaded: full })
              if (topped.models.length > config.models.length) {
                pi.registerProvider(PROVIDER_ID, topped)
                logger.info(`pi-our-free-model: top-up complete — ${topped.models.length} models`)
              }
            }
          } catch {
            /* the gateway keeps running; the next start refreshes the list */
          }
        }, 8000).unref?.()
      }
      return { service: running, config }
    })().catch((error) => {
      ready = null
      throw error
    })
    return ready
  }

  pi.registerCommand('free-models', {
    description: t.description,
    handler: async (args, ctx) => {
      const sub = (args || '').trim().toLowerCase()
      const notify = (message) => ctx.ui?.notify?.(message)
      try {
        const { service: running, config } = await boot()
        const { runtime, assets } = state

        if (sub === 'open' || sub === 'ui' || sub === 'login') {
          openBrowser(running.url)
          return notify(t.panel(running.url, running.key))
        }

        if (sub === 'refresh' || sub === 'reload') {
          const full = await waitForFullCatalog(running)
          const updated = await buildProviderConfig(running, logger, { preloaded: full })
          pi.registerProvider(PROVIDER_ID, updated)
          return notify(t.refreshed(updated.models.length))
        }

        if (sub === 'update' || sub === 'check') {
          const latest = await fetchLatestPin()
          if (!latest) return notify(t.checkFailed)
          if (latest.revision === runtime.revision) return notify(t.upToDate(runtime.revision))
          const result = await materializeRevision(latest.revision, latest.digest, { logger })
          if (!result.ok) return notify(t.pullFailed(result.error))
          writePointer(resolveCacheRoot(), latest.revision)
          return notify(t.updated(latest.revision, result.fileCount, runtime.revision))
        }

        if (sub === 'runtimes') {
          const snapshots = snapshotDir(resolveCacheRoot(), '')
          const installed = fs.existsSync(snapshots)
            ? fs.readdirSync(snapshots).filter((name) => !name.includes('.staging-') && !name.includes('.previous-')).sort()
            : []
          return notify(t.runtimes(runtime.source, runtime.revision, snapshots, installed.length ? installed.join(', ') : t.none, assets.length))
        }

        notify(t.ready(config.models.length, running.url, runtime.source, runtime.revision))
      } catch (error) {
        notify(t.unavailable(error?.message ?? error))
      }
    },
  })

  // Not awaited: pi waits on this factory, and the gateway start + catalog wait is the 14s.
  boot().then(() => autoUpdate(state.runtime, logger)).catch((error) => {
    logger.warn('pi-our-free-model: could not start the gateway: ' + (error?.message ?? error))
  })
}
