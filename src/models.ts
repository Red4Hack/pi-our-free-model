import { readCatalogMeta, readSettings, waitForFullCatalog } from './gateway.ts'

/* ==== model discovery and the pi provider registration ==== */

/**
 * Static list used only until the gateway answers its first /v1/models.
 *
 * Deliberately short. This is not a catalog — it is the difference between a
 * usable /model picker on a cold start and an empty one.
 */
const FALLBACK_MODELS = [
  { id: 'stealth/glyph-cluster', name: 'Glyph Cluster', contextWindow: 256_000 },
  { id: 'openrouter/free', name: 'OpenRouter Free', contextWindow: 200_000 },
  { id: 'inclusionai/ling-3.1-flash', name: 'Ling 3.1 Flash', contextWindow: 262_144 },
  { id: 'mimo-v2.6-flash-free', name: 'MiMo v2.6 Flash', contextWindow: 128_000 },
  { id: 'nemotron-3.5-lightning-free', name: 'Nemotron 3.5 Lightning', contextWindow: 128_000 },
  { id: 'longcat-2.5-preview-free', name: 'LongCat 2.5 Preview', contextWindow: 128_000 },
]

/**
 * Models the gateway lists but cannot drive a chat turn.
 *
 * The catalog carries probe and local-helper lanes. Advertising one in /model
 * would invite a turn that ends in a canned string.
 */
const NON_CHAT_MODEL_IDS = new Set(['jev-1.13-free', 'exo-free'])

/** Channel prefixes the gateway uses, spelled the way upstream's docs do. */
const CHANNEL_LABELS = {
  workbuddy: 'WorkBuddy',
  buddy: 'CodeBuddy',
  lobsterai: 'LobsterAI',
  qoder: 'Qoder',
  qodercn: 'Qoder CN',
  codearts: 'CodeArts',
  cline: 'Cline',
  loomy: 'Loomy',
  raccoon: 'Raccoon',
  minimax: 'MiniMax',
  zcode: 'ZCode',
  gemini: 'Gemini',
  codeassist: 'CodeAssist',
  kilo: 'Kilo',
  opencode: 'OpenCode',
  free: 'free pool',
}

export function normalizeModelId(id) {
  const raw = String(id ?? '').trim()
  if (!raw) return raw
  const parts = raw.split('/')
  if (parts.length > 1 && (parts[0] === 'our-free-model' || parts[0] === 'our-free-model-standalone')) {
    return parts.slice(1).join('/')
  }
  return raw
}

/**
 * Build the display name.
 *
 * pi groups rows by provider, so the channel has to be visible in the row itself
 * or the user cannot tell which of six "Ling" entries is which. The multiplier
 * suffix comes from the upstream catalog's own pricing string rather than from a
 * local rule, so it stays true when upstream changes its pricing.
 */
function formatModelDisplayName(entry, meta) {
  const id = entry.id
  const rawName = typeof entry.name === 'string' ? entry.name.trim() : ''
  const info = meta?.get ? (meta.get(entry.id) ?? meta.get(id)) : null

  const parts = id.split('/')
  const channel = parts.length > 1 ? parts[0] : ''
  const subName = parts.length > 1 ? parts.slice(1).join('/') : id
  const channelLabel = CHANNEL_LABELS[channel.toLowerCase()] ?? channel

  let tag = ''
  if (id.endsWith('-free') || id.includes('/free') || rawName.includes('免费') || rawName.includes('x0.00')) {
    tag = 'free'
  } else {
    const match = rawName.match(/x\d+(?:\.\d+)?/i)
    if (match) tag = match[0]
  }

  let cleanName = (info?.name || rawName).replace(/·\s*(?:x\d+(?:\.\d+)?|免费|x0\.00→免费).*$/i, '').trim()
  if (!cleanName || cleanName === subName) {
    cleanName = subName
      .split('/')
      .pop()
      .replace(/[-_]+/g, ' ')
      .replace(/\b\w/g, (character) => character.toUpperCase())
      .replace(/\s*Free\b/i, '')
  }

  const label = channelLabel ? `[${channelLabel}] ${cleanName}` : cleanName
  return tag ? `${label} · ${tag}` : label
}

function toPiModel(entry, meta) {
  const id = normalizeModelId(entry.id)
  const info = meta?.get ? (meta.get(entry.id) ?? meta.get(id)) : null
  const contextWindow = info?.contextWindow ?? entry.contextWindow ?? 128_000
  const maxTokens = Math.min(info?.maxOutput ?? 32_000, contextWindow)
  return {
    id,
    name: formatModelDisplayName(entry, meta),
    reasoning: info?.reasoning !== false,
    input: info?.vision ? ['text', 'image'] : ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens: maxTokens > 0 ? maxTokens : 32_000,
    compat: {
      // Both are asserted by upstream's own request builder, not observed here:
      // the gateway rejects OpenAI's `developer` role and reads `max_tokens`.
      supportsDeveloperRole: false,
      supportsFinishReason: false,
      maxTokensField: 'max_tokens',
    },
  }
}

export function collectModels(discovered, meta) {
  const byId = new Map()
  for (const model of FALLBACK_MODELS) byId.set(model.id, toPiModel(model, meta))
  for (const entry of discovered ?? []) {
    if (NON_CHAT_MODEL_IDS.has(entry.id)) continue
    const model = toPiModel(entry, meta)
    byId.set(model.id, model)
  }
  return [...byId.values()]
}

/**
 * Build the provider config.
 *
 * One object, rebuilt wholesale. A partial patch would leave stale rows in pi's
 * picker, and re-registering is cheap enough that a top-up is safe rather than a
 * race.
 */
export async function buildProviderConfig(service, logger, { preloaded }: { preloaded?: any } = {}) {
  const meta = readCatalogMeta(service.dataDir)
  const discovered = preloaded ?? (await waitForFullCatalog(service))
  const models = collectModels(discovered, meta)
  return {
    baseUrl: service.url + '/v1',
    apiKey: service.key,
    api: 'openai-completions',
    models,
  }
}


/** Provider config from saved settings and the last catalog, with no network: lets /model work at once. */
export function buildEarlyConfig(dataDir) {
  const settings = readSettings(dataDir)
  if (!settings?.forwardKey || !Number.isInteger(settings.standalonePort)) return null
  const meta = readCatalogMeta(dataDir)
  return {
    baseUrl: `http://127.0.0.1:${settings.standalonePort}/v1`,
    apiKey: settings.forwardKey,
    api: 'openai-completions',
    models: collectModels([...meta.keys()].map((id) => ({ id })), meta),
  }
}
