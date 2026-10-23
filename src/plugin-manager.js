'use strict'

const fs = require('node:fs')
const path = require('node:path')

const PLUGIN_ROOT = path.resolve(__dirname, '..', 'plugins')

const DEFAULTS = Object.freeze({
  'world-change-commands': { enabled: true, settings: {} },
  'auto-authentication': { enabled: true, settings: {} },
  'conditional-chat': { enabled: true, settings: {} },
  'scheduled-messages': { enabled: true, settings: {} },
  'auto-reconnect': { enabled: true, settings: {} },
  'global-connection-queue': { enabled: true, settings: {} },
  'proxy-rotation': { enabled: true, settings: { attemptsPerProxy: 1 } },
  broadcast: { enabled: true, settings: { intervalMs: 500, cooldownMs: 10000 } },
  statistics: { enabled: true, settings: { sampleIntervalMs: 5000, historyLimit: 180 } },
  'log-exporter': { enabled: true, settings: { maxEntries: 500 } },
  'position-tracker': { enabled: true, settings: { sampleIntervalMs: 2000 } },
  'command-workflow': { enabled: true, settings: {} },
  'memory-budget': { enabled: true, settings: { limitMb: 4096 } },
  'auto-respawn': { enabled: true, settings: { delayMs: 1000 } },
  'auto-eat': { enabled: false, settings: { foodThreshold: 14, intervalMs: 5000 } },
  'auto-armor': { enabled: false, settings: { intervalMs: 7000 } }
})

function loadManifests (pluginRoot = PLUGIN_ROOT) {
  if (!fs.existsSync(pluginRoot)) return []
  return fs.readdirSync(pluginRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => {
      const file = path.join(pluginRoot, entry.name, 'plugin.json')
      if (!fs.existsSync(file)) return null
      const manifest = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (manifest.id !== entry.name || !DEFAULTS[manifest.id]) throw new Error(`Invalid plugin manifest: ${entry.name}`)
      return Object.freeze({
        id: manifest.id,
        name: String(manifest.name),
        version: String(manifest.version || '1.0.0'),
        description: String(manifest.description || ''),
        category: String(manifest.category || 'Utility'),
        icon: String(manifest.icon || '◇'),
        route: String(manifest.route || 'plugins'),
        permissions: Array.isArray(manifest.permissions) ? manifest.permissions.map(String) : []
      })
    })
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name))
}

function normalizePlugins (rawPlugins = {}) {
  if (rawPlugins == null) rawPlugins = {}
  if (typeof rawPlugins !== 'object' || Array.isArray(rawPlugins)) throw new Error('Plugin settings are invalid')
  const normalized = {}
  for (const [id, defaults] of Object.entries(DEFAULTS)) {
    const raw = rawPlugins[id]
    if (raw != null && (typeof raw !== 'object' || Array.isArray(raw))) throw new Error(`Plugin settings are invalid: ${id}`)
    if (raw?.settings != null && (typeof raw.settings !== 'object' || Array.isArray(raw.settings))) throw new Error(`Plugin settings are invalid: ${id}`)
    normalized[id] = {
      enabled: raw?.enabled == null ? defaults.enabled : Boolean(raw.enabled),
      settings: { ...defaults.settings, ...(raw?.settings || {}) }
    }
  }
  const memoryLimit = Number(normalized['memory-budget'].settings.limitMb)
  if (!Number.isInteger(memoryLimit) || memoryLimit < 256 || memoryLimit > 32768) throw new Error('Memory budget must be between 256 and 32768 MB')
  normalized['memory-budget'].settings.limitMb = memoryLimit
  const sampleIntervalMs = Number(normalized['position-tracker'].settings.sampleIntervalMs)
  if (!Number.isInteger(sampleIntervalMs) || sampleIntervalMs < 250 || sampleIntervalMs > 60000) throw new Error('Position sample interval must be between 250 and 60000 ms')
  normalized['position-tracker'].settings.sampleIntervalMs = sampleIntervalMs
  const respawnDelayMs = Number(normalized['auto-respawn'].settings.delayMs)
  if (!Number.isInteger(respawnDelayMs) || respawnDelayMs < 0 || respawnDelayMs > 60000) throw new Error('Auto Respawn delay must be between 0 and 60 seconds')
  normalized['auto-respawn'].settings.delayMs = respawnDelayMs
  const foodThreshold = Number(normalized['auto-eat'].settings.foodThreshold)
  const eatIntervalMs = Number(normalized['auto-eat'].settings.intervalMs)
  if (!Number.isInteger(foodThreshold) || foodThreshold < 1 || foodThreshold > 19) throw new Error('Auto Eat threshold must be between 1 and 19')
  if (!Number.isInteger(eatIntervalMs) || eatIntervalMs < 1000 || eatIntervalMs > 60000) throw new Error('Auto Eat interval must be between 1 and 60 seconds')
  normalized['auto-eat'].settings.foodThreshold = foodThreshold
  normalized['auto-eat'].settings.intervalMs = eatIntervalMs
  const armorIntervalMs = Number(normalized['auto-armor'].settings.intervalMs)
  if (!Number.isInteger(armorIntervalMs) || armorIntervalMs < 1000 || armorIntervalMs > 60000) throw new Error('Auto Armor interval must be between 1 and 60 seconds')
  normalized['auto-armor'].settings.intervalMs = armorIntervalMs
  const attemptsPerProxy = Number(normalized['proxy-rotation'].settings.attemptsPerProxy)
  if (!Number.isInteger(attemptsPerProxy) || attemptsPerProxy < 1 || attemptsPerProxy > 10) throw new Error('Proxy attempts must be between 1 and 10')
  normalized['proxy-rotation'].settings.attemptsPerProxy = attemptsPerProxy
  const broadcastIntervalMs = Number(normalized.broadcast.settings.intervalMs)
  const broadcastCooldownMs = Number(normalized.broadcast.settings.cooldownMs)
  if (!Number.isInteger(broadcastIntervalMs) || broadcastIntervalMs < 100 || broadcastIntervalMs > 10000) throw new Error('Broadcast interval must be between 0.1 and 10 seconds')
  if (!Number.isInteger(broadcastCooldownMs) || broadcastCooldownMs < 1000 || broadcastCooldownMs > 300000) throw new Error('Broadcast cooldown must be between 1 and 300 seconds')
  normalized.broadcast.settings.intervalMs = broadcastIntervalMs
  normalized.broadcast.settings.cooldownMs = broadcastCooldownMs
  const statsSampleIntervalMs = Number(normalized.statistics.settings.sampleIntervalMs)
  const statsHistoryLimit = Number(normalized.statistics.settings.historyLimit)
  if (!Number.isInteger(statsSampleIntervalMs) || statsSampleIntervalMs < 1000 || statsSampleIntervalMs > 60000) throw new Error('Statistics interval must be between 1 and 60 seconds')
  if (!Number.isInteger(statsHistoryLimit) || statsHistoryLimit < 30 || statsHistoryLimit > 2000) throw new Error('Statistics history limit must be between 30 and 2000 samples')
  normalized.statistics.settings.sampleIntervalMs = statsSampleIntervalMs
  normalized.statistics.settings.historyLimit = statsHistoryLimit
  const maxLogEntries = Number(normalized['log-exporter'].settings.maxEntries)
  if (!Number.isInteger(maxLogEntries) || maxLogEntries < 100 || maxLogEntries > 5000) throw new Error('Log retention must be between 100 and 5000 entries')
  normalized['log-exporter'].settings.maxEntries = maxLogEntries
  return normalized
}

class PluginManager {
  constructor (settings, pluginRoot = PLUGIN_ROOT) {
    this.manifests = loadManifests(pluginRoot)
    this.settings = normalizePlugins(settings)
    const loaded = new Set(this.manifests.map(plugin => plugin.id))
    const missing = Object.keys(DEFAULTS).filter(id => !loaded.has(id))
    if (missing.length) throw new Error(`Built-in plugins are missing: ${missing.join(', ')}`)
  }

  isEnabled (id) {
    return Boolean(this.settings[id]?.enabled)
  }

  getSettings (id) {
    return this.settings[id]?.settings || {}
  }

  update (settings) {
    this.settings = normalizePlugins(settings)
  }

  status () {
    return this.manifests.map(manifest => ({
      ...manifest,
      enabled: this.isEnabled(manifest.id),
      settings: { ...this.getSettings(manifest.id) }
    }))
  }
}

module.exports = { DEFAULTS, PLUGIN_ROOT, PluginManager, loadManifests, normalizePlugins }
