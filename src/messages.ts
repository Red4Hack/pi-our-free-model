/** User-facing strings. English by default; Chinese when PI_OUR_FREE_MODEL_LANG / LC_ALL / LANG starts with zh. */
const short = (rev) => String(rev ?? 'unknown').slice(0, 10)

const EN = {
  description: 'Our Free Model status / refresh / update (free-models [status|refresh|update|open|runtimes])',
  panel: (url, key) => `Dashboard: ${url}\nAPI key: ${key}`,
  refreshed: (n) => `Refreshed: ${n} models.`,
  checkFailed: 'Could not check upstream (network or GitHub API limit).',
  upToDate: (rev) => `Already on the latest pin: ${short(rev)}`,
  updated: (rev, n, cur) => `Fetched upstream ${short(rev)} (${n} files) into the cache.\nRestart pi to use it; this session still runs ${short(cur)}.`,
  pullFailed: (err) => `Fetch failed: ${err}`,
  none: '(none)',
  runtimes: (src, rev, dir, list, assets) => `Current: ${src} @ ${short(rev)}\nCache: ${dir}\nCached pins: ${list}\nWeb assets: ${assets} files`,
  ready: (n, url, src, rev) =>
    `Our Free Model ready: ${n} models\nGateway: ${url}  (${src} @ ${short(rev)})\n` +
    '• /free-models open      open the dashboard\n• /free-models refresh   refresh the model list\n' +
    '• /free-models update    fetch new upstream commits\n• /free-models runtimes  show the runtime cache',
  unavailable: (msg) => `Our Free Model unavailable: ${msg}`,
  rollback: (rev) => `pi-our-free-model: cached runtime ${short(rev)} failed to start; rolled back to the pin.`,
}

const ZH = {
  description: 'Our Free Model 状态 / 刷新 / 更新 (free-models [status|refresh|update|open|runtimes])',
  panel: (url, key) => `管理面板: ${url}\nAPI Key: ${key}`,
  refreshed: (n) => `已刷新，当前 ${n} 个模型。`,
  checkFailed: '检查上游更新失败（网络或 GitHub API 限制）。',
  upToDate: (rev) => `已是最新 pin: ${short(rev)}`,
  updated: (rev, n, cur) => `已拉取上游 ${short(rev)}（${n} 个文件）并放入缓存。\n重启 pi 后生效；当前会话仍跑 ${short(cur)}。`,
  pullFailed: (err) => `拉取失败: ${err}`,
  none: '(无)',
  runtimes: (src, rev, dir, list, assets) => `当前: ${src} @ ${short(rev)}\n缓存: ${dir}\n已缓存 pin: ${list}\nweb 资源: ${assets} 个文件`,
  ready: (n, url, src, rev) =>
    `Our Free Model 就绪：${n} 个模型\n网关: ${url}  (${src} @ ${short(rev)})\n` +
    '• /free-models open      打开管理面板\n• /free-models refresh   刷新模型清单\n' +
    '• /free-models update    检查并拉取上游新提交\n• /free-models runtimes  查看运行时缓存',
  unavailable: (msg) => `Our Free Model 不可用: ${msg}`,
  rollback: (rev) => `pi-our-free-model: 缓存运行时 ${short(rev)} 启动失败，已回退到 pin。`,
}

const lang = process.env.PI_OUR_FREE_MODEL_LANG || process.env.LC_ALL || process.env.LANG || ''
export const t = /^zh/i.test(lang) ? ZH : EN
