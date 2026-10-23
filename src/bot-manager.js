'use strict'

const { EventEmitter } = require('node:events')
const mineflayer = require('mineflayer')
const { SocksClient } = require('socks')
const { assignProxyPools } = require('./proxies')
const { resolveMinecraftTarget } = require('./server-address')
const { PluginManager } = require('./plugin-manager')
const { ExternalPluginManager } = require('./external-plugin-manager')
const { conditionMatches } = require('./workflow-v2')

function sleep (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function stringifyReason (reason) {
  if (typeof reason === 'string') return reason
  try { return JSON.stringify(reason) } catch { return String(reason) }
}

function unwrapNbt (node, depth = 0) {
  if (depth > 16 || node == null || typeof node !== 'object') return node
  if (Array.isArray(node)) return node.map(value => unwrapNbt(value, depth + 1))
  if (typeof node.type === 'string' && Object.hasOwn(node, 'value')) {
    if (node.type === 'compound') {
      const result = {}
      for (const [key, value] of Object.entries(node.value || {})) result[key] = unwrapNbt(value, depth + 1)
      return result
    }
    if (node.type === 'list') {
      const list = node.value || {}
      return Array.isArray(list.value) ? list.value.map(value => unwrapNbt({ type: list.type, value }, depth + 1)) : []
    }
    return unwrapNbt(node.value, depth + 1)
  }
  return node
}

function flattenChatComponent (component, depth = 0) {
  if (depth > 16 || component == null) return ''
  if (typeof component === 'string') {
    const trimmed = component.trim()
    if (/^[\[{]/.test(trimmed)) {
      try { return flattenChatComponent(JSON.parse(trimmed), depth + 1) } catch {}
    }
    return component
  }
  if (typeof component === 'number' || typeof component === 'boolean') return String(component)
  if (Array.isArray(component)) return component.map(value => flattenChatComponent(value, depth + 1)).join('')
  if (typeof component !== 'object') return ''

  const plain = component.type && Object.hasOwn(component, 'value') ? unwrapNbt(component) : component
  if (plain !== component) return flattenChatComponent(plain, depth + 1)

  let text = ''
  if (typeof plain.text === 'string' || typeof plain.text === 'number') text += String(plain.text)
  else if (typeof plain.fallback === 'string') text += plain.fallback
  else if (typeof plain.translate === 'string') text += plain.translate
  else if (plain.score && typeof plain.score === 'object' && plain.score.value != null) text += String(plain.score.value)
  else if (typeof plain.selector === 'string') text += plain.selector
  if (Array.isArray(plain.with) && plain.with.length) text += ` (${plain.with.map(value => flattenChatComponent(value, depth + 1)).join(', ')})`
  if (Array.isArray(plain.extra)) text += plain.extra.map(value => flattenChatComponent(value, depth + 1)).join('')
  return text
}

function formatKickReason (reason) {
  const decoded = flattenChatComponent(reason)
    .replace(/§[0-9A-FK-OR]/gi, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (decoded) return decoded.slice(0, 1000)
  return stringifyReason(reason).slice(0, 1000)
}

class BotManager extends EventEmitter {
  constructor (config, accounts, proxies, options = {}) {
    super()
    this.config = config
    this.accounts = accounts.slice(0, config.fleet.accountCount)
    this.proxies = proxies
    this.proxyPools = assignProxyPools(this.accounts, proxies, config.fleet.proxiesPerAccount)
    this.pluginManager = new PluginManager(config.plugins)
    this.entries = new Map()
    this.running = false
    this.startGeneration = 0
    this.entriesPaused = false
    this.entryQueue = []
    this.entryQueueSet = new Set()
    this.entryQueueRunning = false
    this.logs = []
    this.logSequence = 0
    this.recentMessages = new Map()
    this.broadcast = {
      running: false,
      sent: 0,
      total: 0,
      generation: 0,
      lastStartedAt: 0
    }
    this.config.scheduledMessage ||= { enabled: false, message: '', intervalMs: 300_000 }
    this.config.conditionalRules ||= []
    this.config.groups ||= {}
    this.config.workflowV2 ||= { enabled: true, flows: [] }
    this.scheduledTimer = null
    this.scheduledNextAt = null
    this.startedAt = null
    this.resolvedTarget = null
    this.stats = {
      connectionAttempts: 0,
      successfulConnections: 0,
      proxyErrors: 0,
      reconnects: 0,
      kicks: 0,
      disconnects: 0,
      commandsSent: 0,
      broadcastSent: 0
    }
    this.statsHistory = []
    this.lastStatsSampleAt = 0
    this.lastMemoryWarningAt = 0
    this.requestConnectionPermit = typeof options.requestConnectionPermit === 'function'
      ? options.requestConnectionPermit
      : async () => {}

    this.accounts.forEach((account, index) => {
      this.entries.set(account.username, {
        index,
        username: account.username,
        state: 'bekliyor',
        desired: false,
        bot: null,
        proxyIndex: 0,
        proxyLabel: '-',
        attempts: 0,
        worldChanges: 0,
        lastError: '',
        connectedAt: null,
        position: null,
        dimension: '',
        lastPositionSampleAt: 0,
        commandEpoch: 0,
        workflowEpoch: 0,
        lastWorldChangeAt: 0,
        ruleCooldowns: new Map(),
        flowCooldowns: new Map(),
        reconnectTimer: null,
        history: [],
        ping: null,
        health: null,
        food: null,
        foodSaturation: null,
        xp: null,
        gameMode: '',
        yaw: null,
        pitch: null,
        maintenanceBusy: false,
        lastEatCheckAt: 0,
        lastArmorCheckAt: 0
      })
    })
    this.externalPlugins = new ExternalPluginManager(options.externalPluginRoot || require('node:path').resolve(process.cwd(), 'extensions'), config.externalPlugins, (level, message) => this.log(level, message))
    this.maintenanceTimer = setInterval(() => this.maintainBots(), 1000)
    this.maintenanceTimer.unref?.()
  }

  log (level, message, username = '') {
    const id = ++this.logSequence
    const item = { id, cursor: id, time: new Date().toISOString(), level, username, message }
    this.logs.push(item)
    const maxEntries = this.pluginManager.getSettings('log-exporter').maxEntries
    if (this.logs.length > maxEntries) this.logs.splice(0, this.logs.length - maxEntries)
    const entry = username ? this.entries.get(username) : null
    if (entry) {
      entry.history.push(item)
      if (entry.history.length > 100) entry.history.splice(0, entry.history.length - 100)
    }
    this.emit('log', item)
    return item
  }

  activitySince (rawAfter = 0, rawLimit = 100) {
    const after = Number(rawAfter)
    const limit = Math.min(200, Math.max(1, Number(rawLimit) || 100))
    const validAfter = Number.isSafeInteger(after) && after >= 0 ? after : 0
    const reset = validAfter > this.logSequence
    const cursor = reset ? 0 : validAfter
    const logs = this.logs
      .filter(item => Number(item.cursor || item.id) > cursor)
      .sort((left, right) => Number(left.cursor || left.id) - Number(right.cursor || right.id))
      .slice(-limit)
    return {
      logs,
      cursor: this.logSequence,
      reset
    }
  }

  logChat (message, username, position) {
    const cleaned = String(message || '').replace(/\s+/g, ' ').trim().slice(0, 500)
    if (!cleaned) return
    const now = Date.now()
    const key = `${position || 'chat'}:${cleaned}`
    const previous = this.recentMessages.get(key)
    if (previous && now - previous.time < 5000) {
      if (username && !previous.item.usernames.includes(username)) previous.item.usernames.push(username)
      previous.item.count = previous.item.usernames.length || 1
      previous.item.cursor = ++this.logSequence
      if (!previous.updateTimer) {
        previous.updateTimer = setTimeout(() => {
          previous.updateTimer = null
          this.emit('log:update', previous.item)
        }, 100)
        previous.updateTimer.unref?.()
      }
      return
    }
    const item = this.log('chat', cleaned, username)
    item.usernames = username ? [username] : []
    item.count = item.usernames.length || 1
    this.recentMessages.set(key, { time: now, item, updateTimer: null })
    if (this.recentMessages.size > 200) {
      for (const [oldKey, entry] of this.recentMessages) {
        if (now - entry.time > 5000) this.recentMessages.delete(oldKey)
      }
    }
  }

  memoryMb () {
    return Math.round(process.memoryUsage().rss / 1024 / 1024)
  }

  incrementStat (name) {
    if (this.pluginManager.isEnabled('statistics')) this.stats[name]++
  }

  physicsDisabled () {
    return this.config.optimizations?.disableBotPhysics !== false
  }

  updateOptimizations (optimizations) {
    this.config.optimizations = { ...optimizations }
    const physicsEnabled = !this.physicsDisabled()
    for (const entry of this.entries.values()) {
      if (entry.bot) entry.bot.physicsEnabled = physicsEnabled
    }
    this.log('success', `Bot physics ${physicsEnabled ? 'enabled' : 'disabled'} for this instance`)
  }

  updateBypass (bypass) {
    this.config.bypass = { ...bypass }
    this.log('success', `Bypass settings updated: resource packs ${this.resourcePackHandlingEnabled() ? 'on' : 'off'}, transfer compatibility ${this.transferCompatibilityEnabled() ? 'on' : 'off'}`)
  }

  resourcePackHandlingEnabled () {
    return this.config.bypass?.resourcePackHandling !== false
  }

  transferCompatibilityEnabled () {
    return this.config.bypass?.transferCompatibility !== false
  }

  hasMemoryCapacity (writeLog = false) {
    if (!this.pluginManager.isEnabled('memory-budget')) return true
    const limitMb = this.pluginManager.getSettings('memory-budget').limitMb
    const memoryMb = this.memoryMb()
    if (memoryMb < limitMb) return true
    if (writeLog && Date.now() - this.lastMemoryWarningAt > 10000) {
      this.lastMemoryWarningAt = Date.now()
      this.log('warn', `Memory budget reached (${memoryMb}/${limitMb} MB). New connections are paused.`)
    }
    return false
  }

  enqueueEntry (entry) {
    if (!entry?.desired || entry.bot || this.entryQueueSet.has(entry.username)) return
    this.entryQueueSet.add(entry.username)
    this.entryQueue.push(entry.username)
  }

  async drainEntryQueue () {
    if (this.entryQueueRunning || this.entriesPaused || !this.running) return
    this.entryQueueRunning = true
    try {
      while (this.running && !this.entriesPaused && this.entryQueue.length) {
        if (!this.hasMemoryCapacity(true)) return
        const username = this.entryQueue.shift()
        this.entryQueueSet.delete(username)
        const entry = this.entries.get(username)
        if (!entry?.desired || entry.bot) continue
        await this.requestConnectionPermit(entry.username)
        if (!this.running || this.entriesPaused || !entry.desired || entry.bot) {
          if (entry?.desired && !entry.bot) this.enqueueEntry(entry)
          continue
        }
        this.connect(entry)
        if (this.entryQueue.length) await sleep(this.config.fleet.staggerMs)
      }
    } finally {
      this.entryQueueRunning = false
      if (this.running && !this.entriesPaused && this.entryQueue.length) setImmediate(() => this.drainEntryQueue())
    }
  }

  pauseEntries () {
    if (!this.running) throw new Error('Start the fleet before pausing entries')
    if (this.entriesPaused) return true
    this.entriesPaused = true
    let interrupted = 0
    for (const entry of this.entries.values()) {
      if (!entry.desired || entry.state === 'aktif') continue
      if (entry.reconnectTimer) {
        clearTimeout(entry.reconnectTimer)
        entry.reconnectTimer = null
      }
      if (entry.state === 'baglaniyor' && entry.bot) {
        const bot = entry.bot
        entry.bot = null
        entry.commandEpoch++
        entry.state = 'bekliyor'
        interrupted++
        try { bot.quit('Entry queue paused') } catch {}
      }
      this.enqueueEntry(entry)
    }
    this.log('info', `Entry queue paused${interrupted ? `; ${interrupted} in-progress connection(s) returned to the queue` : ''}`)
    return true
  }

  resumeEntries () {
    if (!this.running) throw new Error('Start the fleet before resuming entries')
    if (!this.entriesPaused) return false
    this.entriesPaused = false
    this.log('info', `Entry queue resumed with ${this.entryQueue.length} account(s) waiting`)
    this.drainEntryQueue().catch(error => this.log('error', `Entry queue error: ${error.message}`))
    return false
  }

  toggleEntriesPaused () {
    return this.entriesPaused ? this.resumeEntries() : this.pauseEntries()
  }

  async start (limit) {
    if (!this.hasMemoryCapacity()) throw new Error('Memory budget reached; increase the limit or close other launcher instances')
    if (this.config.fleet.requireProxy && this.proxyPools.some(pool => pool.length !== 3)) {
      throw new Error('Proxies are required: add 3 SOCKS5 proxies for every account')
    }
    if (!this.running) {
      this.running = true
      this.startedAt = new Date().toISOString()
      this.armScheduledMessage()
    }
    const count = Math.min(Number(limit) || this.accounts.length, this.accounts.length)
    this.log('info', `Starting ${count} bots`)

    for (let i = 0; i < count; i++) {
      const entry = this.entries.get(this.accounts[i].username)
      entry.desired = true
      this.enqueueEntry(entry)
    }
    await this.drainEntryQueue()
  }

  addBots (rawCount) {
    if (!this.running) throw new Error('Start an initial bot amount before adding more')
    if (!this.hasMemoryCapacity()) throw new Error('Memory budget reached; increase the limit or stop some bots')
    const count = Number(rawCount)
    const candidates = [...this.entries.values()].filter(entry => !entry.desired && !entry.bot)
    if (!Number.isInteger(count) || count < 1 || count > candidates.length) {
      throw new Error(`Additional amount must be between 1 and ${candidates.length}`)
    }
    const selected = candidates.slice(0, count)
    if (this.config.fleet.requireProxy && selected.some(entry => this.proxyPools[entry.index].length !== 3)) {
      throw new Error('Proxies are required: add 3 SOCKS5 proxies for every additional account')
    }
    for (const entry of selected) {
      entry.desired = true
      this.enqueueEntry(entry)
    }
    const target = [...this.entries.values()].filter(entry => entry.desired).length
    this.log('info', `Added ${selected.length} bots to the entry target; target is now ${target}`)
    this.drainEntryQueue().catch(error => this.log('error', `Entry queue error: ${error.message}`))
    return { added: selected.length, target }
  }

  async startOnly (usernames) {
    if (!this.hasMemoryCapacity()) throw new Error('Memory budget reached; increase the limit or close other launcher instances')
    const requested = [...new Set(usernames)]
    const selected = requested.map(username => this.entries.get(username))
    const missing = requested.filter((_, index) => !selected[index])
    if (missing.length) throw new Error(`Preset accounts were not found: ${missing.join(', ')}`)
    if (this.config.fleet.requireProxy && selected.some(entry => this.proxyPools[entry.index].length !== 3)) {
      throw new Error('Proxies are required: add 3 SOCKS5 proxies for every preset account')
    }

    const selectedNames = new Set(requested)
    this.startGeneration++
    this.running = true
    this.startedAt ||= new Date().toISOString()
    this.armScheduledMessage()
    this.entryQueue.length = 0
    this.entryQueueSet.clear()

    for (const entry of this.entries.values()) {
      entry.desired = selectedNames.has(entry.username)
      if (entry.desired) continue
      entry.commandEpoch++
      entry.workflowEpoch++
      if (entry.reconnectTimer) clearTimeout(entry.reconnectTimer)
      entry.reconnectTimer = null
      const bot = entry.bot
      entry.bot = null
      entry.state = 'durduruldu'
      if (bot) {
        try { bot.quit('Stopped because the account is outside the preset') } catch {}
      }
    }

    this.log('info', `Starting only ${selected.length} preset bots`)
    for (const entry of selected) {
      entry.desired = true
      this.enqueueEntry(entry)
    }
    await this.drainEntryQueue()
  }

  stop () {
    this.running = false
    this.startGeneration++
    this.entriesPaused = false
    this.entryQueue.length = 0
    this.entryQueueSet.clear()
    this.broadcast.running = false
    this.broadcast.generation++
    this.clearScheduledMessage()
    for (const entry of this.entries.values()) {
      entry.desired = false
      entry.commandEpoch++
      entry.workflowEpoch++
      if (entry.reconnectTimer) clearTimeout(entry.reconnectTimer)
      entry.reconnectTimer = null
      const bot = entry.bot
      entry.bot = null
      entry.state = 'durduruldu'
      if (bot) {
        try { bot.quit('Stopped from the control panel') } catch {}
      }
    }
    this.log('info', 'All bots stopped')
  }

  stopCount (rawCount) {
    const count = Number(rawCount)
    const candidates = [...this.entries.values()].filter(entry => entry.desired || entry.bot).reverse()
    if (!Number.isInteger(count) || count < 1 || count > candidates.length) {
      throw new Error(`Stop amount must be between 1 and ${candidates.length}`)
    }

    const selected = candidates.slice(0, count)
    const selectedNames = new Set(selected.map(entry => entry.username))
    this.entryQueue = this.entryQueue.filter(username => !selectedNames.has(username))
    for (const username of selectedNames) this.entryQueueSet.delete(username)

    for (const entry of selected) {
      entry.desired = false
      entry.commandEpoch++
      entry.workflowEpoch++
      if (entry.reconnectTimer) clearTimeout(entry.reconnectTimer)
      entry.reconnectTimer = null
      const bot = entry.bot
      entry.bot = null
      entry.state = 'durduruldu'
      entry.connectedAt = null
      if (bot) {
        try { bot.quit('Stopped by amount control') } catch {}
      }
    }

    if (![...this.entries.values()].some(entry => entry.desired || entry.bot)) {
      this.running = false
      this.entriesPaused = false
      this.broadcast.running = false
      this.broadcast.generation++
      this.clearScheduledMessage()
    }
    this.log('info', `${selected.length} bots stopped (last-started first)`)
    return selected.length
  }

  resolveBroadcastEntries (target = { type: 'all' }) {
    const active = [...this.entries.values()].filter(entry => entry.state === 'aktif' && entry.bot)
    const type = target?.type || 'all'
    if (type === 'all') return active
    if (type === 'first') {
      const count = Number(target.count)
      if (!Number.isInteger(count) || count < 1 || count > this.accounts.length) throw new Error(`First-account count must be between 1 and ${this.accounts.length}`)
      const names = new Set(this.accounts.slice(0, count).map(account => account.username))
      return active.filter(entry => names.has(entry.username))
    }
    if (type === 'selected') {
      const names = new Set(Array.isArray(target.usernames) ? target.usernames : [])
      if (!names.size) throw new Error('Select at least one account')
      return active.filter(entry => names.has(entry.username))
    }
    if (type === 'group') {
      const groupName = String(target.groupName || '')
      const group = this.config.groups[groupName]
      if (!group) throw new Error('Account group was not found')
      const names = new Set(group)
      return active.filter(entry => names.has(entry.username))
    }
    throw new Error('Message target is invalid')
  }

  queueBroadcast (rawMessage, target = { type: 'all' }, internal = false) {
    if (!internal && !this.pluginManager.isEnabled('broadcast')) throw new Error('Broadcast plugin is disabled')
    const message = String(rawMessage || '').trim()
    if (!message) throw new Error('Enter a message to send')
    if (message.length > 256) throw new Error('Message cannot exceed 256 characters')
    if (this.broadcast.running) throw new Error('The previous broadcast is still running')
    const now = Date.now()
    const broadcastSettings = this.pluginManager.getSettings('broadcast')
    if (now - this.broadcast.lastStartedAt < broadcastSettings.cooldownMs) throw new Error(`Wait ${Math.ceil(broadcastSettings.cooldownMs / 1000)} seconds before starting another broadcast`)
    const entries = this.resolveBroadcastEntries(target)
    if (!entries.length) throw new Error('There are no active accounts for this message')

    const generation = ++this.broadcast.generation
    this.broadcast.running = true
    this.broadcast.sent = 0
    this.broadcast.total = entries.length
    this.broadcast.lastStartedAt = now
    this.log('info', `Broadcast queued for ${entries.length} active accounts`)
    this.runBroadcast(entries, message, generation).catch(error => {
      this.broadcast.running = false
      this.log('error', `Broadcast error: ${error.message}`)
    })
    return entries.length
  }

  async runBroadcast (entries, message, generation) {
    for (const entry of entries) {
      if (generation !== this.broadcast.generation || !this.broadcast.running) return
      if (entry.state === 'aktif' && entry.bot) {
        try {
          entry.bot.chat(message)
          this.broadcast.sent++
          this.incrementStat('broadcastSent')
        } catch (error) {
          this.log('error', `Message could not be sent: ${error.message}`, entry.username)
        }
      }
      await sleep(this.pluginManager.getSettings('broadcast').intervalMs)
    }
    if (generation !== this.broadcast.generation) return
    this.broadcast.running = false
    this.log('success', `Broadcast complete: ${this.broadcast.sent}/${this.broadcast.total}`)
  }

  reconnectFailed () {
    if (!this.pluginManager.isEnabled('auto-reconnect')) throw new Error('Auto Reconnect plugin is disabled')
    if (!this.running) {
      this.running = true
      this.startedAt ||= new Date().toISOString()
      this.armScheduledMessage()
    }
    let count = 0
    for (const entry of this.entries.values()) {
      if (!entry.bot && ['hata', 'atildi', 'koptu', 'durduruldu', 'bekliyor'].includes(entry.state)) {
        count++
        entry.desired = true
        this.enqueueEntry(entry)
      }
    }
    this.drainEntryQueue().catch(error => this.log('error', `Entry queue error: ${error.message}`))
    this.log('info', `${count} bots queued for reconnection`)
    return count
  }

  updateAutomation (commands, scheduledMessage, conditionalRules = []) {
    this.config.commands = commands
    this.config.scheduledMessage = scheduledMessage
    this.config.conditionalRules = conditionalRules
    this.armScheduledMessage()
    this.log('success', 'Automation settings saved and applied')
  }

  updateWorkflowV2 (workflowV2) {
    this.config.workflowV2 = workflowV2
    for (const entry of this.entries.values()) entry.workflowEpoch++
    this.log('success', 'Workflow 2.0 settings saved and applied')
  }

  getEntry (rawUsername) {
    const username = String(rawUsername || '')
    const entry = this.entries.get(username)
    if (!entry) throw new Error('Bot account was not found')
    return entry
  }

  stopBot (rawUsername) {
    const entry = this.getEntry(rawUsername)
    entry.desired = false
    entry.commandEpoch++
    entry.workflowEpoch++
    if (entry.reconnectTimer) clearTimeout(entry.reconnectTimer)
    entry.reconnectTimer = null
    const bot = entry.bot
    entry.bot = null
    entry.state = 'durduruldu'
    entry.connectedAt = null
    if (bot) {
      try { bot.quit('Stopped from bot details') } catch {}
    }
    this.log('info', 'Bot stopped', entry.username)
  }

  restartBot (rawUsername) {
    const entry = this.getEntry(rawUsername)
    if (!this.running) {
      this.running = true
      this.startedAt ||= new Date().toISOString()
      this.armScheduledMessage()
    }
    entry.desired = true
    entry.commandEpoch++
    entry.workflowEpoch++
    if (entry.reconnectTimer) clearTimeout(entry.reconnectTimer)
    entry.reconnectTimer = null
    const bot = entry.bot
    entry.bot = null
    entry.state = 'bekliyor'
    entry.connectedAt = null
    if (bot) {
      try { bot.quit('Manual restart') } catch {}
    }
    setTimeout(() => {
      if (!this.running || !entry.desired || entry.bot) return
      this.enqueueEntry(entry)
      this.drainEntryQueue().catch(error => this.log('error', `Entry queue error: ${error.message}`))
    }, 500)
    this.log('info', 'Manual restart queued', entry.username)
  }

  retryBot (rawUsername) {
    const entry = this.getEntry(rawUsername)
    if (entry.bot || ['aktif', 'baglaniyor'].includes(entry.state)) throw new Error('This bot is already online or connecting')
    if (!this.running) {
      this.running = true
      this.startedAt ||= new Date().toISOString()
      this.armScheduledMessage()
    }
    entry.desired = true
    entry.commandEpoch++
    entry.workflowEpoch++
    if (entry.reconnectTimer) clearTimeout(entry.reconnectTimer)
    entry.reconnectTimer = null
    entry.state = 'bekliyor'
    entry.connectedAt = null
    this.enqueueEntry(entry)
    this.drainEntryQueue().catch(error => this.log('error', `Entry queue error: ${error.message}`))
    this.log('info', 'Single-account retry queued', entry.username)
    return entry.username
  }

  sendBotChat (rawUsername, rawMessage) {
    const entry = this.getEntry(rawUsername)
    const message = String(rawMessage || '').trim()
    if (!message || message.length > 256) throw new Error('Message must contain 1-256 characters')
    if (!entry.bot || entry.state !== 'aktif') throw new Error('This bot is not online')
    entry.bot.chat(message)
    this.incrementStat('commandsSent')
    this.log('command', `Bot terminal: ${message}`, entry.username)
  }

  botDetails (rawUsername) {
    const entry = this.getEntry(rawUsername)
    const bot = entry.bot
    const inventory = bot?.inventory?.items?.().map(item => ({ name: item.name, displayName: item.displayName, count: item.count, slot: item.slot })) || []
    return {
      ...this.botSnapshot(entry, bot),
      inventory,
      heldItem: bot?.heldItem ? { name: bot.heldItem.name, displayName: bot.heldItem.displayName, count: bot.heldItem.count } : null,
      history: entry.history.slice().reverse()
    }
  }

  updateGroups (groups) {
    this.config.groups = groups
  }

  updateReconnectPolicy (settings) {
    this.config.fleet.autoReconnect = settings.autoReconnect
    this.config.fleet.reconnectBaseMs = settings.reconnectBaseMs
    this.config.fleet.reconnectMaxMs = settings.reconnectMaxMs
    this.log('success', `Automatic reconnect ${settings.autoReconnect ? 'enabled' : 'disabled'}`)
  }

  updatePlugins (plugins) {
    this.pluginManager.update(plugins)
    this.config.plugins = this.pluginManager.settings
    for (const entry of this.entries.values()) entry.commandEpoch++
    if (!this.pluginManager.isEnabled('auto-reconnect')) {
      for (const entry of this.entries.values()) {
        if (entry.reconnectTimer) clearTimeout(entry.reconnectTimer)
        entry.reconnectTimer = null
      }
    }
    if (!this.pluginManager.isEnabled('broadcast')) {
      this.broadcast.running = false
      this.broadcast.generation++
    }
    if (!this.pluginManager.isEnabled('scheduled-messages')) this.clearScheduledMessage()
    else this.armScheduledMessage()
    this.log('success', 'Plugin settings saved and applied')
  }

  clearScheduledMessage () {
    if (this.scheduledTimer) clearTimeout(this.scheduledTimer)
    this.scheduledTimer = null
    this.scheduledNextAt = null
  }

  armScheduledMessage () {
    this.clearScheduledMessage()
    const scheduled = this.config.scheduledMessage
    if (!this.pluginManager.isEnabled('scheduled-messages') || !this.running || !scheduled?.enabled || !scheduled.message) return
    this.scheduledNextAt = new Date(Date.now() + scheduled.intervalMs).toISOString()
    this.scheduledTimer = setTimeout(() => {
      this.scheduledTimer = null
      this.scheduledNextAt = null
      try {
        const count = this.queueBroadcast(scheduled.message, { type: 'all' }, true)
        this.log('command', `Scheduled message sent (${count} accounts): ${scheduled.message}`)
      } catch (error) {
        this.log('warn', `Scheduled message skipped this cycle: ${error.message}`)
      } finally {
        this.armScheduledMessage()
      }
    }, scheduled.intervalMs)
  }

  createConnectOption (entry, pool, startIndex = 0) {
    if (!pool?.length) return undefined
    return async client => {
      let lastError
      try {
        const target = await this.getResolvedTarget()
        const candidateCount = Math.min(3, pool.length)
        // The configured timeout belongs to each proxy candidate. Splitting one
        // total budget across three fallbacks made healthy but slower proxies
        // fail after only a few seconds and caused unnecessary retry storms.
        const perProxyTimeout = Math.max(3000, this.config.fleet.proxyTimeoutMs)
        for (let offset = 0; offset < candidateCount; offset++) {
          const candidateIndex = (startIndex + offset) % pool.length
          const proxy = pool[candidateIndex]
          entry.proxyLabel = proxy.label
          try {
            const info = await SocksClient.createConnection({
              proxy: {
                host: proxy.host,
                port: proxy.port,
                type: 5,
                userId: proxy.userId || undefined,
                password: proxy.password || undefined
              },
              command: 'connect',
              destination: { host: target.connectHost, port: target.connectPort },
              timeout: perProxyTimeout
            })
            // A working sticky session remains preferred. Rotation now happens
            // only after an actual proxy failure, not after every reconnect.
            entry.proxyIndex = candidateIndex
            client.setSocket(info.socket)
            client.emit('connect')
            return
          } catch (error) {
            lastError = error
            this.incrementStat('proxyErrors')
            entry.proxyIndex = (candidateIndex + 1) % pool.length
            if (offset + 1 < candidateCount) {
              this.log('warn', `Proxy option ${offset + 1} failed (${error.message}); trying option ${offset + 2}`, entry.username)
            }
          }
        }
        throw new Error(`All ${candidateCount} proxy options failed: ${lastError?.message || 'unknown proxy error'}`)
      } catch (error) {
        client.emit('error', error)
        client.emit('end', 'proxyConnectFailed')
      }
    }
  }

  installTransferCompatibility (entry, bot) {
    const client = bot?._client
    if (!client || client.__afkTransferCompatibility) return
    client.__afkTransferCompatibility = true

    const configurationPackets = new Set([
      'accept_code_of_conduct',
      'configuration_acknowledged',
      'cookie_response',
      'custom_payload',
      'finish_configuration',
      'keep_alive',
      'pong',
      'resource_pack_receive',
      'select_known_packs',
      'settings'
    ])
    const originalWrite = client.write.bind(client)
    let reconfiguring = false
    let droppedPackets = 0

    client.write = (name, params) => {
      if (this.transferCompatibilityEnabled() && reconfiguring && !configurationPackets.has(name)) {
        droppedPackets++
        return
      }
      return originalWrite(name, params)
    }

    client.prependListener?.('start_configuration', () => {
      if (!this.transferCompatibilityEnabled()) return
      reconfiguring = true
      droppedPackets = 0
      bot.physicsEnabled = false
      this.log('info', 'Transfer compatibility mode enabled', entry.username)
    })

    client.on('state', newState => {
      if (!reconfiguring || String(newState).toLowerCase() !== 'play') return
      reconfiguring = false
      bot.physicsEnabled = !this.physicsDisabled()
      this.log('info', `Transfer configuration completed; blocked ${droppedPackets} stray PLAY packet(s)`, entry.username)
    })

    bot.on('resourcePack', () => {
      if (!this.resourcePackHandlingEnabled()) return
      setImmediate(() => {
        if (entry.bot !== bot) return
        try {
          bot.acceptResourcePack()
          this.log('info', 'Resource pack acknowledged for server transfer', entry.username)
        } catch (error) {
          this.log('warn', `Resource pack acknowledgement failed: ${error.message}`, entry.username)
        }
      })
    })
  }

  async getResolvedTarget () {
    if (!this.resolvedTarget) {
      this.resolvedTarget = resolveMinecraftTarget(this.config.server.host, this.config.server.port)
        .then(target => {
          this.log('info', `Minecraft target resolved: ${this.config.server.host}:${this.config.server.port} -> ${target.connectHost}:${target.connectPort}`)
          return target
        })
        .catch(error => {
          this.resolvedTarget = null
          throw error
        })
    }
    return this.resolvedTarget
  }

  connect (entry) {
    if (!this.running || this.entriesPaused || !entry.desired || entry.bot || !this.hasMemoryCapacity(true)) return
    const pool = this.proxyPools[entry.index]
    const proxyIndex = pool.length ? entry.proxyIndex % pool.length : 0
    const proxy = pool.length ? pool[proxyIndex] : null
    entry.proxyLabel = proxy?.label || 'direct'
    entry.state = 'baglaniyor'
    entry.lastError = ''
    entry.attempts++
    this.incrementStat('connectionAttempts')
    entry.commandEpoch++

    const options = {
      host: this.config.server.host,
      port: this.config.server.port,
      fakeHost: this.config.server.host,
      username: entry.username,
      auth: this.config.server.auth,
      version: this.config.server.version,
      physicsEnabled: !this.physicsDisabled(),
      viewDistance: 'tiny',
      colorsEnabled: false,
      defaultChatPatterns: false,
      hideErrors: true,
      connect: this.createConnectOption(entry, pool, proxyIndex)
    }
    if (!options.connect) delete options.connect

    let bot
    try {
      bot = mineflayer.createBot(options)
    } catch (error) {
      entry.state = 'hata'
      entry.lastError = error.message
      this.log('error', error.message, entry.username)
      this.scheduleReconnect(entry)
      return
    }
    entry.bot = bot
    bot.physicsEnabled = !this.physicsDisabled()
    this.installTransferCompatibility(entry, bot)
    this.emitPluginHook('onBotCreated', entry, bot)

    let hasSpawned = false
    let pendingConfiguration = false

    bot.on('spawn', () => {
      if (entry.bot !== bot) return
      entry.state = 'aktif'
      entry.connectedAt = new Date().toISOString()
      entry.attempts = 0
      bot.physicsEnabled = !this.physicsDisabled()
      if (!hasSpawned) {
        hasSpawned = true
        this.incrementStat('successfulConnections')
        this.log('success', `Connected (${entry.proxyLabel})`, entry.username)
        this.refreshBotVitals(entry, bot)
        this.emitPluginHook('onSpawn', entry, bot, { firstSpawn: true })
        if (this.pluginManager.isEnabled('auto-authentication') && this.pluginManager.isEnabled('command-workflow')) {
          this.runCommands(entry, bot, this.config.commands.initial, 'initial join')
        }
        this.triggerWorkflows('join', entry, bot, { message: 'join' })
      } else {
        this.handleWorldChange(entry, bot, 'respawn')
      }
    })

    bot.on('respawn', () => {
      if (hasSpawned) this.handleWorldChange(entry, bot, 'respawn')
    })

    bot.on('login', () => {
      if (hasSpawned) this.handleWorldChange(entry, bot, 'new game session')
    })

    bot._client?.on('start_configuration', () => {
      if (entry.bot === bot && hasSpawned) pendingConfiguration = true
    })

    bot._client?.on('state', newState => {
      if (entry.bot !== bot || !pendingConfiguration) return
      if (String(newState).toLowerCase() !== 'play') return
      pendingConfiguration = false
      this.handleWorldChange(entry, bot, 'backend server transfer')
    })

    bot.on('messagestr', (message, position) => {
      if (entry.bot !== bot) return
      this.logChat(message, entry.username, position)
      this.handleConditionalRules(entry, bot, message)
      this.triggerWorkflows('chat', entry, bot, { message: String(message || '') })
      this.emitPluginHook('onChat', entry, bot, { message: String(message || ''), position })
    })

    bot.on('health', () => {
      if (entry.bot !== bot) return
      this.refreshBotVitals(entry, bot)
      this.emitPluginHook('onHealth', entry, bot)
    })

    bot.on('death', () => {
      if (entry.bot !== bot) return
      this.log('warn', 'Bot died', entry.username)
      this.emitPluginHook('onDeath', entry, bot)
      if (!this.pluginManager.isEnabled('auto-respawn')) return
      const delay = this.pluginManager.getSettings('auto-respawn').delayMs
      setTimeout(() => {
        if (!this.running || !entry.desired || entry.bot !== bot) return
        try {
          bot.respawn()
          this.log('command', 'Auto Respawn requested', entry.username)
        } catch (error) {
          this.log('error', `Auto Respawn failed: ${error.message}`, entry.username)
        }
      }, delay)
    })

    bot.on('move', () => {
      if (entry.bot !== bot || !this.pluginManager.isEnabled('position-tracker')) return
      const now = Date.now()
      const interval = this.pluginManager.getSettings('position-tracker').sampleIntervalMs
      if (now - entry.lastPositionSampleAt < interval) return
      entry.lastPositionSampleAt = now
      const position = bot.entity?.position
      if (position) entry.position = { x: Math.round(position.x * 10) / 10, y: Math.round(position.y * 10) / 10, z: Math.round(position.z * 10) / 10 }
      entry.yaw = Number.isFinite(bot.entity?.yaw) ? Math.round(bot.entity.yaw * 1000) / 1000 : entry.yaw
      entry.pitch = Number.isFinite(bot.entity?.pitch) ? Math.round(bot.entity.pitch * 1000) / 1000 : entry.pitch
      entry.dimension = String(bot.game?.dimension || entry.dimension || '')
    })

    bot.on('kicked', reason => {
      if (entry.bot !== bot) return
      entry.state = 'atildi'
      entry.lastError = formatKickReason(reason)
      this.incrementStat('kicks')
      this.log('warn', `Kicked: ${entry.lastError}`, entry.username)
      this.emitPluginHook('onKicked', entry, bot, { reason: entry.lastError })
    })

    bot.on('error', error => {
      if (entry.bot !== bot) return
      entry.state = 'hata'
      entry.lastError = error.message
      this.log('error', error.message, entry.username)
      this.emitPluginHook('onError', entry, bot, { error: error.message })
    })

    bot.on('end', reason => {
      if (entry.bot !== bot) return
      entry.bot = null
      entry.commandEpoch++
      if (!['atildi', 'hata'].includes(entry.state)) entry.state = 'koptu'
      entry.lastError ||= stringifyReason(reason).slice(0, 300)
      entry.connectedAt = null
      this.incrementStat('disconnects')
      this.log('warn', `Connection closed: ${stringifyReason(reason)}`, entry.username)
      this.emitPluginHook('onDisconnect', entry, bot, { reason: stringifyReason(reason) })
      this.scheduleReconnect(entry)
    })
  }

  handleConditionalRules (entry, bot, rawMessage) {
    if (!this.pluginManager.isEnabled('conditional-chat')) return
    const message = String(rawMessage || '').replace(/\s+/g, ' ').trim()
    if (!message) return
    const now = Date.now()
    for (const rule of this.config.conditionalRules) {
      if (!rule.enabled) continue
      let matched = false
      if (rule.matchMode === 'exact') matched = message.toLowerCase() === rule.match.toLowerCase()
      else if (rule.matchMode === 'regex') {
        try { matched = new RegExp(rule.match, 'i').test(message) } catch { matched = false }
      } else matched = message.toLowerCase().includes(rule.match.toLowerCase())
      if (!matched) continue
      const previous = entry.ruleCooldowns.get(rule.id) || 0
      if (now - previous < rule.cooldownMs) continue
      entry.ruleCooldowns.set(rule.id, now)
      setTimeout(() => {
        if (!this.pluginManager.isEnabled('conditional-chat') || !this.running || entry.bot !== bot || entry.state !== 'aktif') return
        try {
          bot.chat(rule.response)
          this.incrementStat('commandsSent')
          this.log('command', `Rule matched [${rule.match}]: ${rule.response}`, entry.username)
        } catch (error) {
          this.log('error', `Conditional message could not be sent: ${error.message}`, entry.username)
        }
      }, rule.delayMs)
    }
  }

  handleWorldChange (entry, bot, signal) {
    if (!this.running || entry.bot !== bot) return false
    const now = Date.now()
    if (now - entry.lastWorldChangeAt < 5000) return false
    entry.lastWorldChangeAt = now
    entry.worldChanges++
    this.log('info', `Server/world changed #${entry.worldChanges} (${signal})`, entry.username)
    entry.dimension = String(bot.game?.dimension || entry.dimension || '')
    if (this.pluginManager.isEnabled('world-change-commands') && this.pluginManager.isEnabled('command-workflow')) {
      this.runCommands(entry, bot, this.config.commands.onWorldChange, 'server/world change')
    }
    this.triggerWorkflows('world-change', entry, bot, { message: signal, signal })
    this.emitPluginHook('onWorldChange', entry, bot, { signal })
    return true
  }

  async runCommands (entry, bot, commands, source) {
    const epoch = ++entry.commandEpoch
    for (const command of commands) {
      await sleep(command.delayMs)
      if (!this.running || entry.bot !== bot || entry.commandEpoch !== epoch) return
      try {
        bot.chat(command.text)
        this.incrementStat('commandsSent')
        this.log('command', `${source}: ${command.text}`, entry.username)
      } catch (error) {
        this.log('error', `Command could not be sent: ${error.message}`, entry.username)
        return
      }
    }
  }

  scheduleReconnect (entry) {
    if (!this.running || !entry.desired || !this.pluginManager.isEnabled('auto-reconnect') || !this.config.fleet.autoReconnect || entry.reconnectTimer) return
    const attempt = Math.max(1, entry.attempts)
    const base = this.config.fleet.reconnectBaseMs
    const max = this.config.fleet.reconnectMaxMs
    const backoff = Math.min(max, base * (2 ** Math.min(attempt - 1, 5)))
    const jitter = Math.floor(Math.random() * Math.min(10000, Math.max(1000, backoff * 0.2)))
    const delay = backoff + jitter
    entry.reconnectTimer = setTimeout(() => {
      entry.reconnectTimer = null
      if (!this.hasMemoryCapacity(true)) return this.scheduleReconnect(entry)
      this.incrementStat('reconnects')
      this.enqueueEntry(entry)
      this.drainEntryQueue().catch(error => this.log('error', `Entry queue error: ${error.message}`))
    }, delay)
    this.log('info', `Retrying in ${Math.round(delay / 1000)} seconds`, entry.username)
  }

  refreshBotVitals (entry, bot) {
    if (!bot || entry.bot !== bot) return
    entry.health = Number.isFinite(bot.health) ? bot.health : entry.health
    entry.food = Number.isFinite(bot.food) ? bot.food : entry.food
    entry.foodSaturation = Number.isFinite(bot.foodSaturation) ? bot.foodSaturation : entry.foodSaturation
    entry.xp = bot.experience ? { level: bot.experience.level || 0, progress: bot.experience.progress || 0, points: bot.experience.points || 0 } : entry.xp
    entry.gameMode = String(bot.game?.gameMode || entry.gameMode || '')
    entry.ping = Number.isFinite(bot.player?.ping) ? bot.player.ping : (Number.isFinite(bot._client?.latency) ? bot._client.latency : entry.ping)
    const position = bot.entity?.position
    if (position) entry.position = { x: Math.round(position.x * 10) / 10, y: Math.round(position.y * 10) / 10, z: Math.round(position.z * 10) / 10 }
    entry.dimension = String(bot.game?.dimension || entry.dimension || '')
    entry.yaw = Number.isFinite(bot.entity?.yaw) ? Math.round(bot.entity.yaw * 1000) / 1000 : entry.yaw
    entry.pitch = Number.isFinite(bot.entity?.pitch) ? Math.round(bot.entity.pitch * 1000) / 1000 : entry.pitch
  }

  botSnapshot (entry, bot = entry.bot) {
    if (bot) this.refreshBotVitals(entry, bot)
    return {
      username: entry.username,
      state: entry.state,
      desired: entry.desired,
      proxy: entry.proxyLabel,
      nextProxy: this.proxyPools[entry.index]?.length ? this.proxyPools[entry.index][entry.proxyIndex % this.proxyPools[entry.index].length]?.label || '-' : 'direct',
      attempts: entry.attempts,
      worldChanges: entry.worldChanges,
      lastError: entry.lastError,
      connectedAt: entry.connectedAt,
      ping: entry.ping,
      health: entry.health,
      food: entry.food,
      foodSaturation: entry.foodSaturation,
      xp: entry.xp,
      gameMode: entry.gameMode,
      position: entry.position,
      dimension: entry.dimension,
      yaw: entry.yaw,
      pitch: entry.pitch
    }
  }

  triggerWorkflows (event, entry, bot, context = {}) {
    const workflow = this.config.workflowV2
    if (!workflow?.enabled || !this.running || entry.bot !== bot) return
    const now = Date.now()
    for (const flow of workflow.flows) {
      if (!flow.enabled || flow.event !== event) continue
      if (event === 'chat' && !conditionMatches(flow.match, context)) continue
      const previous = entry.flowCooldowns.get(flow.id) || 0
      if (flow.cooldownMs && now - previous < flow.cooldownMs) continue
      entry.flowCooldowns.set(flow.id, now)
      const epoch = entry.workflowEpoch
      this.runWorkflowSteps(flow.steps, entry, bot, { ...context, event, flowName: flow.name }, epoch)
        .catch(error => this.log('error', `Workflow ${flow.name} failed: ${error.message}`, entry.username))
    }
  }

  async runWorkflowSteps (steps, entry, bot, context, epoch) {
    for (const step of steps) {
      if (!this.running || !entry.desired || entry.bot !== bot || entry.workflowEpoch !== epoch) return
      if (step.type === 'delay') {
        await sleep(step.delayMs)
        continue
      }
      if (step.type === 'command') {
        if (step.delayMs) await sleep(step.delayMs)
        if (!this.running || !entry.desired || entry.bot !== bot || entry.workflowEpoch !== epoch) return
        const text = this.interpolateWorkflowText(step.text, entry, context)
        bot.chat(text)
        this.incrementStat('commandsSent')
        this.log('command', `Workflow ${context.flowName}: ${text}`, entry.username)
        continue
      }
      if (step.type === 'condition') {
        const branch = conditionMatches(step.condition, context) ? step.then : step.else
        await this.runWorkflowSteps(branch, entry, bot, context, epoch)
        continue
      }
      if (step.type === 'repeat') {
        for (let index = 0; index < step.count; index++) {
          await this.runWorkflowSteps(step.steps, entry, bot, { ...context, repeatIndex: index + 1 }, epoch)
          if (!this.running || !entry.desired || entry.bot !== bot || entry.workflowEpoch !== epoch) return
        }
      }
    }
  }

  interpolateWorkflowText (text, entry, context) {
    return String(text)
      .replaceAll('{username}', entry.username)
      .replaceAll('{message}', String(context.message || ''))
      .replaceAll('{event}', String(context.event || ''))
      .replaceAll('{repeat}', String(context.repeatIndex || 1))
      .slice(0, 256)
  }

  emitPluginHook (hook, entry, bot, extra = {}) {
    this.externalPlugins.emitHook(hook, plugin => {
      const allowed = permission => plugin.permissions.includes('*') || plugin.permissions.includes(permission)
      const requirePermission = permission => {
        if (!allowed(permission)) throw new Error(`Plugin ${plugin.id} requires permission: ${permission}`)
      }
      const context = {
        event: hook,
        username: entry.username,
        ...extra,
        getState: () => ({ ...this.botSnapshot(entry, bot) }),
        chat: message => {
          requirePermission('bot.chat')
          const text = String(message || '').trim()
          if (!text || text.length > 256) throw new Error('Plugin chat message must contain 1-256 characters')
          if (entry.bot !== bot || entry.state !== 'aktif') throw new Error('Bot is not online')
          bot.chat(text)
          this.log('command', `[${plugin.name}] ${text}`, entry.username)
        },
        respawn: () => {
          requirePermission('bot.respawn')
          if (entry.bot !== bot) throw new Error('Bot is not connected')
          bot.respawn()
        },
        inventory: () => {
          requirePermission('bot.inventory.read')
          return bot.inventory.items().map(item => ({ name: item.name, displayName: item.displayName, count: item.count, slot: item.slot }))
        }
      }
      if (allowed('bot.raw')) context.rawBot = bot
      return Object.freeze(context)
    })
  }

  maintainBots () {
    const now = Date.now()
    for (const entry of this.entries.values()) {
      const bot = entry.bot
      if (!bot || entry.state !== 'aktif' || entry.maintenanceBusy) continue
      this.refreshBotVitals(entry, bot)
      const eat = this.pluginManager.getSettings('auto-eat')
      if (this.pluginManager.isEnabled('auto-eat') && now - entry.lastEatCheckAt >= eat.intervalMs && Number.isFinite(bot.food) && bot.food <= eat.foodThreshold) {
        entry.lastEatCheckAt = now
        this.autoEat(entry, bot)
        continue
      }
      const armor = this.pluginManager.getSettings('auto-armor')
      if (this.pluginManager.isEnabled('auto-armor') && now - entry.lastArmorCheckAt >= armor.intervalMs) {
        entry.lastArmorCheckAt = now
        this.autoArmor(entry, bot)
      }
    }
  }

  async autoEat (entry, bot) {
    entry.maintenanceBusy = true
    try {
      const foods = bot.inventory.items().map(item => {
        const data = bot.registry?.foodsByName?.[item.name] || bot.registry?.foodsArray?.find(food => food.name === item.name)
        return { item, points: Number(data?.foodPoints || data?.food || 0), saturation: Number(data?.saturation || 0) }
      }).filter(candidate => candidate.points > 0).sort((a, b) => b.points - a.points || b.saturation - a.saturation)
      if (!foods.length) return
      await bot.equip(foods[0].item, 'hand')
      await bot.consume()
      this.log('command', `Auto Eat consumed ${foods[0].item.displayName || foods[0].item.name}`, entry.username)
    } catch (error) {
      this.log('warn', `Auto Eat skipped: ${error.message}`, entry.username)
    } finally {
      entry.maintenanceBusy = false
    }
  }

  armorScore (name) {
    const material = name.startsWith('netherite_') ? 60 : name.startsWith('diamond_') ? 50 : name.startsWith('iron_') ? 40 : name.startsWith('chainmail_') ? 30 : name.startsWith('golden_') ? 20 : name.startsWith('leather_') ? 10 : name === 'turtle_helmet' ? 35 : 0
    return material
  }

  async autoArmor (entry, bot) {
    entry.maintenanceBusy = true
    try {
      const slots = [
        { destination: 'head', suffix: '_helmet', equippedSlot: 5 },
        { destination: 'torso', suffix: '_chestplate', equippedSlot: 6 },
        { destination: 'legs', suffix: '_leggings', equippedSlot: 7 },
        { destination: 'feet', suffix: '_boots', equippedSlot: 8 }
      ]
      for (const slot of slots) {
        const candidates = bot.inventory.items().filter(item => item.name.endsWith(slot.suffix) || (slot.destination === 'head' && item.name === 'turtle_helmet')).sort((a, b) => this.armorScore(b.name) - this.armorScore(a.name))
        const best = candidates[0]
        const equipped = bot.inventory.slots[slot.equippedSlot]
        if (!best || this.armorScore(best.name) <= this.armorScore(equipped?.name || '')) continue
        await bot.equip(best, slot.destination)
        this.log('command', `Auto Armor equipped ${best.displayName || best.name}`, entry.username)
      }
    } catch (error) {
      this.log('warn', `Auto Armor skipped: ${error.message}`, entry.username)
    } finally {
      entry.maintenanceBusy = false
    }
  }

  dispose () {
    this.stop()
    clearInterval(this.maintenanceTimer)
    this.externalPlugins.dispose()
  }

  status (options = {}) {
    const compact = options.compact === true
    const includeLogs = options.includeLogs !== false
    const positionTracking = this.pluginManager.isEnabled('position-tracker')
    const counts = {}
    const bots = []
    let desiredCount = 0
    for (const entry of this.entries.values()) {
      counts[entry.state] = (counts[entry.state] || 0) + 1
      if (entry.desired) desiredCount++
      const snapshot = compact
        ? {
            username: entry.username,
            state: entry.state,
            desired: entry.desired,
            proxy: entry.proxyLabel,
            ping: entry.ping,
            worldChanges: entry.worldChanges,
            lastError: entry.lastError,
            position: entry.position,
            dimension: entry.dimension
          }
        : this.botSnapshot(entry)
      if (!positionTracking) {
        snapshot.position = null
        snapshot.dimension = ''
      }
      bots.push(snapshot)
    }
    const now = Date.now()
    const memoryMb = this.memoryMb()
    const statisticsSettings = this.pluginManager.getSettings('statistics')
    if (this.pluginManager.isEnabled('statistics') && now - this.lastStatsSampleAt >= statisticsSettings.sampleIntervalMs) {
      this.lastStatsSampleAt = now
      this.statsHistory.push({ time: now, memoryMb, active: counts.aktif || 0, connecting: counts.baglaniyor || 0 })
      if (this.statsHistory.length > statisticsSettings.historyLimit) this.statsHistory.splice(0, this.statsHistory.length - statisticsSettings.historyLimit)
    }
    const status = {
      running: this.running,
      entriesPaused: this.entriesPaused,
      queuedEntries: this.entryQueue.length,
      desiredCount,
      startedAt: this.startedAt,
      counts,
      total: this.accounts.length,
      proxyCount: this.proxies.length,
      bots,
      logs: includeLogs ? this.logs.slice(compact ? -40 : -100).reverse() : [],
      memoryMb,
      server: {
        host: this.config.server.host,
        port: this.config.server.port,
        version: this.config.server.version,
        loopbackOnly: false
      },
      fleet: {
        accountCount: this.config.fleet.accountCount,
        staggerMs: this.config.fleet.staggerMs,
        requireProxy: this.config.fleet.requireProxy,
        proxiesPerAccount: this.config.fleet.proxiesPerAccount,
        proxyTimeoutMs: this.config.fleet.proxyTimeoutMs
      },
      broadcast: {
        running: this.broadcast.running,
        sent: this.broadcast.sent,
        total: this.broadcast.total
      },
      stats: {
        uptimeMs: this.startedAt ? Math.max(0, now - new Date(this.startedAt).getTime()) : 0
      }
    }
    if (compact) return status
    return {
      ...status,
      automation: {
        initial: this.config.commands.initial,
        onWorldChange: this.config.commands.onWorldChange,
        scheduledMessage: this.config.scheduledMessage,
        conditionalRules: this.config.conditionalRules,
        nextScheduledAt: this.scheduledNextAt
      },
      workflowV2: this.config.workflowV2,
      groups: this.config.groups,
      reconnect: {
        autoReconnect: this.config.fleet.autoReconnect,
        reconnectBaseMs: this.config.fleet.reconnectBaseMs,
        reconnectMaxMs: this.config.fleet.reconnectMaxMs
      },
      plugins: this.pluginManager.status(),
      externalPlugins: this.externalPlugins.status(),
      memoryBudget: {
        enabled: this.pluginManager.isEnabled('memory-budget'),
        limitMb: this.pluginManager.getSettings('memory-budget').limitMb,
        reached: !this.hasMemoryCapacity()
      },
      stats: {
        ...this.stats,
        ...status.stats,
        successRate: this.stats.connectionAttempts ? Math.round(this.stats.successfulConnections / this.stats.connectionAttempts * 1000) / 10 : 0,
        history: this.statsHistory
      }
    }
  }
}

module.exports = { BotManager, formatKickReason }
