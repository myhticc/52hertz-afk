'use strict'

const fs = require('node:fs')
const net = require('node:net')
const path = require('node:path')
const safeRegex = require('safe-regex2')
const { normalizePlugins } = require('./plugin-manager')
const { normalizeWorkflowV2 } = require('./workflow-v2')

const ROOT = path.resolve(__dirname, '..')
const MAX_ACCOUNTS = 500

function readJson (fileName, baseDir = ROOT) {
  return JSON.parse(fs.readFileSync(path.join(baseDir, fileName), 'utf8'))
}

function isLoopback (host) {
  const normalized = String(host).trim().toLowerCase().replace(/^\[|\]$/g, '')
  if (normalized === 'localhost' || normalized === '::1') return true
  if (net.isIPv4(normalized)) return normalized.startsWith('127.')
  return false
}

function normalizeCommandList (commands, label) {
  if (!Array.isArray(commands)) throw new Error(`${label} command list is invalid`)
  if (commands.length > 100) throw new Error(`${label} command list cannot exceed 100 steps`)
  return commands.map((command, index) => {
    const text = String(command?.text || '').trim()
    const delayMs = Number(command?.delayMs)
    if (!text) throw new Error(`${label} command ${index + 1} cannot be empty`)
    if (text.length > 256) throw new Error(`${label} command ${index + 1} cannot exceed 256 characters`)
    if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > 600_000) {
      throw new Error(`${label} command ${index + 1} delay must be between 0 and 600 seconds`)
    }
    return { text, delayMs }
  })
}

function normalizeConditionalRules (rules) {
  if (!Array.isArray(rules)) throw new Error('Conditional message rules are invalid')
  if (rules.length > 100) throw new Error('Conditional message rules cannot exceed 100 entries')
  return rules.map((rule, index) => {
    const match = String(rule?.match || '').trim()
    const response = String(rule?.response || '').trim()
    const matchMode = ['includes', 'exact', 'regex'].includes(rule?.matchMode) ? rule.matchMode : 'includes'
    const delayMs = Number(rule?.delayMs)
    const cooldownMs = Number(rule?.cooldownMs)
    if (!match || match.length > 256) throw new Error(`Rule ${index + 1}: match text must contain 1-256 characters`)
    if (!response || response.length > 256) throw new Error(`Rule ${index + 1}: response must contain 1-256 characters`)
    if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > 600_000) throw new Error(`Rule ${index + 1}: delay must be between 0 and 600 seconds`)
    if (!Number.isInteger(cooldownMs) || cooldownMs < 10_000 || cooldownMs > 86_400_000) throw new Error(`Rule ${index + 1}: cooldown must be between 10 seconds and 24 hours`)
    if (matchMode === 'regex') {
      try { new RegExp(match, 'i') } catch { throw new Error(`Rule ${index + 1}: invalid regular expression`) }
      if (!safeRegex(match)) throw new Error(`Rule ${index + 1}: regular expression is too complex`)
    }
    return {
      id: String(rule?.id || `rule-${Date.now()}-${index}`).slice(0, 80),
      enabled: rule?.enabled !== false,
      match,
      matchMode,
      response,
      delayMs,
      cooldownMs
    }
  })
}

function normalizeGroups (groups) {
  if (groups == null) return {}
  if (typeof groups !== 'object' || Array.isArray(groups)) throw new Error('Account groups are invalid')
  const normalized = {}
  for (const [rawName, rawUsers] of Object.entries(groups)) {
    const name = String(rawName).trim()
    if (!name || name.length > 40) throw new Error('Group name must contain 1-40 characters')
    if (['__proto__', 'prototype', 'constructor'].includes(name.toLowerCase())) throw new Error('Group name is reserved')
    if (!Array.isArray(rawUsers)) throw new Error(`Group ${name} is invalid`)
    normalized[name] = [...new Set(rawUsers.map(value => String(value).trim()).filter(Boolean))]
    if (normalized[name].some(username => !/^[A-Za-z0-9_]{3,16}$/.test(username))) throw new Error(`Group ${name} contains an invalid account name`)
  }
  return normalized
}

function normalizeExternalPlugins (raw = {}) {
  if (raw == null) return {}
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('External plugin settings are invalid')
  const normalized = {}
  for (const [id, value] of Object.entries(raw)) {
    if (!/^[a-z][a-z0-9-]{1,63}$/.test(id)) throw new Error(`External plugin id is invalid: ${id}`)
    if (value == null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`External plugin settings are invalid: ${id}`)
    const settings = value.settings == null ? {} : value.settings
    if (typeof settings !== 'object' || Array.isArray(settings)) throw new Error(`External plugin configuration is invalid: ${id}`)
    normalized[id] = { enabled: value.enabled !== false, settings: { ...settings } }
  }
  return normalized
}

function normalizeAutomationSettings (settings) {
  const initial = normalizeCommandList(settings?.initial, 'Initial join')
  const onWorldChange = normalizeCommandList(settings?.onWorldChange, 'Server change')
  const conditionalRules = normalizeConditionalRules(settings?.conditionalRules || [])
  const scheduled = settings?.scheduledMessage || { enabled: false, message: '', intervalMs: 300_000 }
  const enabled = Boolean(scheduled.enabled)
  const message = String(scheduled.message || '').trim()
  const intervalMs = Number(scheduled.intervalMs)
  if (message.length > 256) throw new Error('Scheduled message cannot exceed 256 characters')
  if (enabled && !message) throw new Error('Scheduled message cannot be empty while enabled')
  if (!Number.isInteger(intervalMs) || intervalMs < 60_000 || intervalMs > 86_400_000) {
    throw new Error('Scheduled message interval must be between 1 minute and 24 hours')
  }
  return { initial, onWorldChange, conditionalRules, scheduledMessage: { enabled, message, intervalMs } }
}

function normalizeOptimizations (raw = {}) {
  if (raw == null) raw = {}
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Optimization settings are invalid')
  return {
    deltaStatusUpdates: raw.deltaStatusUpdates == null ? true : Boolean(raw.deltaStatusUpdates),
    disableBotPhysics: raw.disableBotPhysics == null ? true : Boolean(raw.disableBotPhysics)
  }
}

function normalizeBypass (raw = {}) {
  if (raw == null) raw = {}
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Bypass settings are invalid')
  return {
    resourcePackHandling: raw.resourcePackHandling == null ? true : Boolean(raw.resourcePackHandling),
    transferCompatibility: raw.transferCompatibility == null ? true : Boolean(raw.transferCompatibility)
  }
}

function validateConfig (config) {
  const errors = []
  if (!config.server || typeof config.server.host !== 'string') errors.push('server.host is missing')
  if (!Number.isInteger(config.server?.port) || config.server.port < 1 || config.server.port > 65535) errors.push('server.port is invalid')
  if (config.server?.host && (config.server.host.length > 253 || /[\s/]/.test(config.server.host))) errors.push('server.host is invalid')
  if (!/^\d+(?:\.\d+){1,3}$/.test(config.server?.version || '')) errors.push('server.version is invalid')
  if (config.server?.auth !== 'offline') errors.push('server.auth must be offline for generated accounts')
  if (!config.dashboard || !isLoopback(config.dashboard.host)) errors.push('Dashboard may only listen on a loopback address')
  if (!Number.isInteger(config.dashboard?.port) || config.dashboard.port < 1024 || config.dashboard.port > 65535) errors.push('dashboard.port must be between 1024 and 65535')
  if (!Number.isInteger(config.fleet?.accountCount) || config.fleet.accountCount < 1 || config.fleet.accountCount > MAX_ACCOUNTS) errors.push(`accountCount must be between 1 and ${MAX_ACCOUNTS}`)
  if (config.fleet?.proxiesPerAccount !== 3) errors.push('proxiesPerAccount must be exactly 3')
  if (typeof config.fleet?.requireProxy !== 'boolean') errors.push('requireProxy must be true or false')
  if (!Number.isInteger(config.fleet?.staggerMs) || config.fleet.staggerMs < 250 || config.fleet.staggerMs > 60000) errors.push('staggerMs must be between 0.25 and 60 seconds')
  if (!Number.isInteger(config.fleet?.proxyTimeoutMs) || config.fleet.proxyTimeoutMs < 1000 || config.fleet.proxyTimeoutMs > 60000) errors.push('proxyTimeoutMs must be between 1 and 60 seconds')
  if (typeof config.fleet?.autoReconnect !== 'boolean') errors.push('autoReconnect must be true or false')
  if (!Number.isInteger(config.fleet?.reconnectBaseMs) || config.fleet.reconnectBaseMs < 1000 || config.fleet.reconnectBaseMs > 300000) errors.push('reconnectBaseMs must be between 1 and 300 seconds')
  if (!Number.isInteger(config.fleet?.reconnectMaxMs) || config.fleet.reconnectMaxMs < config.fleet?.reconnectBaseMs || config.fleet.reconnectMaxMs > 3600000) errors.push('reconnectMaxMs must be between the initial delay and 1 hour')
  try {
    const automation = normalizeAutomationSettings({
      initial: config.commands?.initial,
      onWorldChange: config.commands?.onWorldChange,
      conditionalRules: config.conditionalRules || [],
      scheduledMessage: config.scheduledMessage
    })
    config.commands = { initial: automation.initial, onWorldChange: automation.onWorldChange }
    config.conditionalRules = automation.conditionalRules
    config.scheduledMessage = automation.scheduledMessage
  } catch (error) {
    errors.push(error.message)
  }
  try { config.groups = normalizeGroups(config.groups) } catch (error) { errors.push(error.message) }
  try { config.plugins = normalizePlugins(config.plugins) } catch (error) { errors.push(error.message) }
  try { config.workflowV2 = normalizeWorkflowV2(config.workflowV2 || { enabled: true, flows: [] }) } catch (error) { errors.push(error.message) }
  try { config.externalPlugins = normalizeExternalPlugins(config.externalPlugins || {}) } catch (error) { errors.push(error.message) }
  try { config.optimizations = normalizeOptimizations(config.optimizations) } catch (error) { errors.push(error.message) }
  try { config.bypass = normalizeBypass(config.bypass) } catch (error) { errors.push(error.message) }
  if (errors.length) throw new Error(errors.join('; '))
  return config
}

function loadConfig (baseDir = ROOT) {
  return validateConfig(readJson('config.json', baseDir))
}

function loadAccounts (baseDir = ROOT) {
  return validateAccounts(readJson('accounts.json', baseDir))
}

function validateAccounts (accounts) {
  if (!Array.isArray(accounts)) throw new Error('accounts.json must contain an array')
  if (!accounts.length || accounts.length > MAX_ACCOUNTS) throw new Error(`accounts.json must contain between 1 and ${MAX_ACCOUNTS} accounts`)
  const names = new Set()
  for (const account of accounts) {
    if (!/^[A-Za-z0-9_]{3,16}$/.test(account.username || '')) throw new Error(`Invalid bot name: ${account.username}`)
    if (names.has(account.username.toLowerCase())) throw new Error(`Duplicate bot name: ${account.username}`)
    names.add(account.username.toLowerCase())
  }
  return accounts
}

module.exports = { MAX_ACCOUNTS, ROOT, isLoopback, loadAccounts, loadConfig, normalizeAutomationSettings, normalizeBypass, normalizeExternalPlugins, normalizeGroups, normalizeOptimizations, validateAccounts, validateConfig }
