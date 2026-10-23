'use strict'

const path = require('node:path')
const { EventEmitter } = require('node:events')
const { Worker } = require('node:worker_threads')
const { assignProxyPools } = require('./proxies')
const { PluginManager } = require('./plugin-manager')

const DEFAULT_SHARD_SIZE = 50

function shardIndexForAccount (accountIndex, shardSize = DEFAULT_SHARD_SIZE) {
  return Math.floor(accountIndex / shardSize)
}

function buildShardDefinitions (accounts, proxies, proxiesPerAccount, shardSize = DEFAULT_SHARD_SIZE) {
  const pools = assignProxyPools(accounts, proxies, proxiesPerAccount)
  const definitions = []
  for (let start = 0; start < accounts.length; start += shardSize) {
    const shardAccounts = accounts.slice(start, start + shardSize)
    definitions.push({
      index: definitions.length,
      start,
      end: start + shardAccounts.length,
      accounts: shardAccounts,
      proxies: pools.slice(start, start + shardAccounts.length).flat()
    })
  }
  return definitions
}

class ShardedBotManager extends EventEmitter {
  constructor (config, accounts, proxies, options = {}) {
    super()
    this.config = config
    this.accounts = accounts.slice(0, config.fleet.accountCount)
    this.proxies = proxies
    this.shardSize = options.shardSize || DEFAULT_SHARD_SIZE
    this.workerPath = options.workerPath || path.join(__dirname, 'bot-worker.js')
    this.workerFactory = options.workerFactory || ((filename, workerOptions) => new Worker(filename, workerOptions))
    this.shardDefinitions = buildShardDefinitions(this.accounts, proxies, config.fleet.proxiesPerAccount, this.shardSize)
    this.shards = new Map()
    this.desiredNames = new Set()
    this.entriesPaused = false
    this.startedAt = null
    this.logs = []
    this.logSequence = 0
    this.workerLogIds = new Map()
    this.pluginManager = new PluginManager(config.plugins)
    this.disposed = false
    this.globalPermitQueue = []
    this.globalPermitTimer = null
    this.lastGlobalPermitAt = 0
    this.statusRevision = 0
    this.botFingerprints = new Map()
    this.statusChanges = []
  }

  get running () {
    return this.desiredNames.size > 0
  }

  log (level, message, username = '') {
    const item = { id: ++this.logSequence, cursor: this.logSequence, time: new Date().toISOString(), level, username, message }
    this.logs.push(item)
    const maxEntries = this.pluginManager.getSettings('log-exporter').maxEntries
    if (this.logs.length > maxEntries) this.logs.splice(0, this.logs.length - maxEntries)
    this.emit('log', item)
    return item
  }

  receiveWorkerLog (shardIndex, workerItem, update = false) {
    const key = `${shardIndex}:${workerItem.id}`
    const existingId = this.workerLogIds.get(key)
    if (update && existingId) {
      const existing = this.logs.find(item => item.id === existingId)
      if (existing) {
        Object.assign(existing, workerItem, { id: existingId, cursor: ++this.logSequence, instance: shardIndex + 1 })
        this.emit('log:update', existing)
        return
      }
    }
    const item = {
      ...workerItem,
      id: ++this.logSequence,
      cursor: this.logSequence,
      instance: shardIndex + 1
    }
    this.workerLogIds.set(key, item.id)
    this.logs.push(item)
    const maxEntries = this.pluginManager.getSettings('log-exporter').maxEntries
    if (this.logs.length > maxEntries) this.logs.splice(0, this.logs.length - maxEntries)
    this.emit('log', item)
  }

  activitySince (rawAfter = 0, rawLimit = 100) {
    const after = Number(rawAfter)
    const limit = Math.min(200, Math.max(1, Number(rawLimit) || 100))
    const validAfter = Number.isSafeInteger(after) && after >= 0 ? after : 0
    const reset = validAfter > this.logSequence
    const cursor = reset ? 0 : validAfter
    return {
      logs: this.logs.filter(item => Number(item.cursor) > cursor).sort((a, b) => a.cursor - b.cursor).slice(-limit),
      cursor: this.logSequence,
      reset
    }
  }

  localDesiredNames (definition) {
    return definition.accounts.map(account => account.username).filter(username => this.desiredNames.has(username))
  }

  ensureShard (index) {
    const existing = this.shards.get(index)
    if (existing && !existing.exited) return existing
    const definition = this.shardDefinitions[index]
    if (!definition) throw new Error(`Bot instance ${index + 1} does not exist`)
    const shardConfig = structuredClone(this.config)
    shardConfig.fleet.accountCount = definition.accounts.length
    const worker = this.workerFactory(this.workerPath, {
      workerData: { config: shardConfig, accounts: definition.accounts, proxies: definition.proxies }
    })
    const shard = { index, worker, ready: false, exited: false, stopping: false, nextRequestId: 1, pending: new Map(), lastStatus: null, lastStatusWarningAt: 0 }
    this.shards.set(index, shard)
    worker.on('message', message => this.handleWorkerMessage(shard, message))
    worker.on('error', error => this.handleWorkerFailure(shard, error))
    worker.on('exit', code => this.handleWorkerExit(shard, code))
    return shard
  }

  handleWorkerMessage (shard, message) {
    if (message?.type === 'ready') {
      shard.ready = true
      this.log('success', `Instance ${shard.index + 1} ready (${this.shardDefinitions[shard.index].accounts.length} account capacity)`)
      return
    }
    if (message?.type === 'log' || message?.type === 'log:update') {
      this.receiveWorkerLog(shard.index, message.item, message.type === 'log:update')
      return
    }
    if (message?.type === 'permit-request') {
      this.queueGlobalPermit(shard, message)
      return
    }
    if (message?.type !== 'result') return
    const pending = shard.pending.get(message.id)
    if (!pending) return
    shard.pending.delete(message.id)
    if (message.error) pending.reject(new Error(message.error))
    else pending.resolve(message.result)
  }

  handleWorkerFailure (shard, error) {
    this.log('error', `Instance ${shard.index + 1} error: ${error.message}`)
  }

  handleWorkerExit (shard, code) {
    shard.exited = true
    for (const pending of shard.pending.values()) pending.reject(new Error(`Instance ${shard.index + 1} stopped`))
    shard.pending.clear()
    if (this.shards.get(shard.index) === shard) this.shards.delete(shard.index)
    this.globalPermitQueue = this.globalPermitQueue.filter(item => item.shard !== shard)
    if (this.disposed || shard.stopping) return
    this.log('warn', `Instance ${shard.index + 1} exited with code ${code}; recovering its accounts`)
    if (this.localDesiredNames(this.shardDefinitions[shard.index]).length) {
      const timer = setTimeout(() => this.reconcileShard(shard.index), 2000)
      timer.unref?.()
    }
  }

  globalQueueEnabled () {
    return this.pluginManager.isEnabled('global-connection-queue')
  }

  grantPermit (item) {
    if (!item?.shard || item.shard.exited || item.shard.stopping) return false
    item.shard.worker.postMessage({ type: 'permit-grant', permitId: item.permitId })
    return true
  }

  queueGlobalPermit (shard, message) {
    const item = { shard, permitId: message.permitId, username: message.username }
    if (!this.globalQueueEnabled()) {
      this.grantPermit(item)
      return
    }
    this.globalPermitQueue.push(item)
    this.scheduleGlobalPermits()
  }

  scheduleGlobalPermits () {
    if (this.globalPermitTimer || this.entriesPaused || !this.globalPermitQueue.length || !this.globalQueueEnabled()) return
    const waitMs = Math.max(0, this.lastGlobalPermitAt + this.config.fleet.staggerMs - Date.now())
    this.globalPermitTimer = setTimeout(() => {
      this.globalPermitTimer = null
      while (this.globalPermitQueue.length) {
        const item = this.globalPermitQueue.shift()
        if (!this.grantPermit(item)) continue
        this.lastGlobalPermitAt = Date.now()
        break
      }
      this.scheduleGlobalPermits()
    }, waitMs)
    this.globalPermitTimer.unref?.()
  }

  flushGlobalPermits () {
    if (this.globalPermitTimer) clearTimeout(this.globalPermitTimer)
    this.globalPermitTimer = null
    for (const item of this.globalPermitQueue.splice(0)) this.grantPermit(item)
  }

  clearGlobalPermits () {
    if (this.globalPermitTimer) clearTimeout(this.globalPermitTimer)
    this.globalPermitTimer = null
    this.globalPermitQueue.length = 0
  }

  callShard (shard, method, ...args) {
    if (!shard || shard.exited) return Promise.reject(new Error('Bot instance is unavailable'))
    const id = shard.nextRequestId++
    const request = new Promise((resolve, reject) => {
      shard.pending.set(id, { resolve, reject })
      shard.worker.postMessage({ id, method, args })
    })
    request.requestId = id
    return request
  }

  callShardWithTimeout (shard, timeoutMs, method, ...args) {
    const request = this.callShard(shard, method, ...args)
    let timer
    const timeout = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        shard.pending.delete(request.requestId)
        reject(new Error(`Instance ${shard.index + 1} did not answer within ${timeoutMs} ms`))
      }, timeoutMs)
      timer.unref?.()
    })
    return Promise.race([request, timeout]).finally(() => clearTimeout(timer))
  }

  reconcileShard (index) {
    const definition = this.shardDefinitions[index]
    const names = this.localDesiredNames(definition)
    if (!names.length) {
      const shard = this.shards.get(index)
      if (shard) this.stopShard(shard)
      return
    }
    const shard = this.ensureShard(index)
    this.callShard(shard, 'startOnly', names).catch(error => this.log('error', `Instance ${index + 1} start failed: ${error.message}`))
    if (this.entriesPaused) {
      this.callShard(shard, 'pauseEntries').catch(error => this.log('warn', `Instance ${index + 1} pause failed: ${error.message}`))
    }
  }

  reconcileAll () {
    for (const definition of this.shardDefinitions) this.reconcileShard(definition.index)
  }

  async stopShard (shard) {
    if (shard.stopping || shard.exited) return
    shard.stopping = true
    try { await this.callShardWithTimeout(shard, 2000, 'stop') } catch {}
    await shard.worker.terminate()
  }

  async start (limit) {
    const count = Math.min(Number(limit) || this.accounts.length, this.accounts.length)
    for (let index = 0; index < count; index++) this.desiredNames.add(this.accounts[index].username)
    this.startedAt ||= new Date().toISOString()
    this.log('info', `Starting ${count} bots across ${Math.ceil(count / this.shardSize)} instance(s)`)
    this.reconcileAll()
  }

  addBots (rawCount) {
    if (!this.running) throw new Error('Start an initial bot amount before adding more')
    const count = Number(rawCount)
    const candidates = this.accounts.filter(account => !this.desiredNames.has(account.username))
    if (!Number.isInteger(count) || count < 1 || count > candidates.length) throw new Error(`Additional amount must be between 1 and ${candidates.length}`)
    for (const account of candidates.slice(0, count)) this.desiredNames.add(account.username)
    this.log('info', `Added ${count} bots; target is now ${this.desiredNames.size}`)
    this.reconcileAll()
    return { added: count, target: this.desiredNames.size }
  }

  async startOnly (usernames) {
    const names = new Set(usernames)
    const missing = [...names].filter(username => !this.accounts.some(account => account.username === username))
    if (missing.length) throw new Error(`Preset accounts were not found: ${missing.join(', ')}`)
    this.desiredNames = names
    this.startedAt ||= new Date().toISOString()
    this.reconcileAll()
  }

  stop () {
    this.desiredNames.clear()
    this.entriesPaused = false
    this.clearGlobalPermits()
    for (const shard of [...this.shards.values()]) this.stopShard(shard)
    this.log('info', 'All bots and instances stopped')
  }

  stopCount (rawCount) {
    const count = Number(rawCount)
    const candidates = this.accounts.filter(account => this.desiredNames.has(account.username)).reverse()
    if (!Number.isInteger(count) || count < 1 || count > candidates.length) throw new Error(`Stop amount must be between 1 and ${candidates.length}`)
    for (const account of candidates.slice(0, count)) this.desiredNames.delete(account.username)
    this.log('info', `${count} bots stopped; target is now ${this.desiredNames.size}`)
    this.reconcileAll()
    if (!this.desiredNames.size) this.startedAt = null
    return count
  }

  shardForUsername (rawUsername) {
    const username = String(rawUsername || '')
    const accountIndex = this.accounts.findIndex(account => account.username === username)
    if (accountIndex < 0) throw new Error('Bot account was not found')
    return { username, index: shardIndexForAccount(accountIndex, this.shardSize) }
  }

  retryBot (rawUsername) {
    const { username, index } = this.shardForUsername(rawUsername)
    this.desiredNames.add(username)
    this.startedAt ||= new Date().toISOString()
    const shard = this.ensureShard(index)
    this.callShard(shard, 'retryBot', username).catch(error => this.log('error', `Retry failed: ${error.message}`, username))
    return username
  }

  async reconnectFailed () {
    const statuses = await this.workerStatuses(true)
    const retryable = []
    for (const status of statuses) {
      for (const bot of status.bots || []) {
        if (bot.desired && ['hata', 'atildi', 'koptu'].includes(bot.state)) retryable.push(bot.username)
      }
    }
    for (const username of retryable) this.retryBot(username)
    this.log('info', `${retryable.length} failed bots queued for reconnection`)
    return retryable.length
  }

  async toggleEntriesPaused () {
    if (!this.running) throw new Error('Start the fleet before pausing entries')
    this.entriesPaused = !this.entriesPaused
    if (this.entriesPaused && this.globalPermitTimer) {
      clearTimeout(this.globalPermitTimer)
      this.globalPermitTimer = null
    }
    const method = this.entriesPaused ? 'pauseEntries' : 'resumeEntries'
    await Promise.all([...this.shards.values()].map(shard => this.callShard(shard, method).catch(error => {
      this.log('warn', `Instance ${shard.index + 1}: ${error.message}`)
    })))
    this.log('info', this.entriesPaused ? 'Entry queues paused in every instance' : 'Entry queues resumed in every instance')
    if (!this.entriesPaused) this.scheduleGlobalPermits()
    return this.entriesPaused
  }

  async queueBroadcast (message, target = { type: 'all' }) {
    const results = await Promise.all([...this.shards.values()].map(shard => this.callShard(shard, 'queueBroadcast', message, target).catch(error => {
      if (/no active accounts/i.test(error.message)) return 0
      throw error
    })))
    return results.reduce((sum, value) => sum + Number(value || 0), 0)
  }

  updateAutomation (commands, scheduledMessage, conditionalRules = []) {
    this.config.commands = commands
    this.config.scheduledMessage = scheduledMessage
    this.config.conditionalRules = conditionalRules
    return Promise.all([...this.shards.values()].map(shard => this.callShard(shard, 'updateAutomation', commands, scheduledMessage, conditionalRules)))
  }

  updatePlugins (plugins) {
    const queueWasEnabled = this.globalQueueEnabled()
    this.config.plugins = plugins
    this.pluginManager.update(plugins)
    const queueIsEnabled = this.globalQueueEnabled()
    if (queueWasEnabled && !queueIsEnabled) this.flushGlobalPermits()
    if (!queueWasEnabled && queueIsEnabled) {
      this.lastGlobalPermitAt = 0
      this.scheduleGlobalPermits()
    }
    return Promise.all([...this.shards.values()].map(shard => this.callShard(shard, 'updatePlugins', plugins)))
  }

  updateOptimizations (optimizations) {
    this.config.optimizations = { ...optimizations }
    return Promise.all([...this.shards.values()].map(shard => this.callShard(shard, 'updateOptimizations', this.config.optimizations)))
  }

  updateBypass (bypass) {
    this.config.bypass = { ...bypass }
    return Promise.all([...this.shards.values()].map(shard => this.callShard(shard, 'updateBypass', this.config.bypass)))
  }

  updateWorkflowV2 (workflowV2) {
    this.config.workflowV2 = workflowV2
    return Promise.all([...this.shards.values()].map(shard => this.callShard(shard, 'updateWorkflowV2', workflowV2)))
  }

  updateGroups (groups) {
    this.config.groups = groups
    return Promise.all([...this.shards.values()].map(shard => this.callShard(shard, 'updateGroups', groups)))
  }

  updateReconnectPolicy (settings) {
    Object.assign(this.config.fleet, settings)
    return Promise.all([...this.shards.values()].map(shard => this.callShard(shard, 'updateReconnectPolicy', settings)))
  }

  async workerStatuses (compact = false) {
    const statuses = []
    await Promise.all([...this.shards.values()].map(async shard => {
      try {
        const status = await this.callShardWithTimeout(shard, 10000, 'status', { compact, includeLogs: false })
        shard.lastStatus = status
        statuses.push({ ...status, instanceIndex: shard.index })
      } catch (error) {
        if (shard.lastStatus) statuses.push({ ...shard.lastStatus, instanceIndex: shard.index })
        if (Date.now() - shard.lastStatusWarningAt >= 30000) {
          shard.lastStatusWarningAt = Date.now()
          this.log('warn', `Instance ${shard.index + 1} status unavailable: ${error.message}`)
        }
      }
    }))
    return statuses.sort((a, b) => a.instanceIndex - b.instanceIndex)
  }

  trackStatusChanges (bots) {
    const changed = []
    for (const bot of bots) {
      const fingerprint = JSON.stringify(bot)
      if (this.botFingerprints.get(bot.username) === fingerprint) continue
      this.botFingerprints.set(bot.username, fingerprint)
      changed.push(bot)
    }
    if (!changed.length) return this.statusRevision
    this.statusRevision++
    this.statusChanges.push({ revision: this.statusRevision, bots: structuredClone(changed) })
    if (this.statusChanges.length > 120) this.statusChanges.splice(0, this.statusChanges.length - 120)
    return this.statusRevision
  }

  async statusDelta (rawAfter = 0) {
    const after = Number(rawAfter)
    const status = await this.status({ compact: true, includeLogs: false })
    const oldestRevision = this.statusChanges[0]?.revision || this.statusRevision
    const reset = !Number.isSafeInteger(after) || after < 0 || after > this.statusRevision || after < oldestRevision - 1 || this.config.optimizations?.deltaStatusUpdates === false
    if (reset) return { ...status, delta: { enabled: this.config.optimizations?.deltaStatusUpdates !== false, reset: true, revision: this.statusRevision } }
    const latestByUsername = new Map()
    for (const batch of this.statusChanges) {
      if (batch.revision <= after) continue
      for (const bot of batch.bots) latestByUsername.set(bot.username, bot)
    }
    return {
      ...status,
      bots: [...latestByUsername.values()],
      delta: { enabled: true, reset: false, revision: this.statusRevision }
    }
  }

  async status (options = {}) {
    const compact = options.compact === true
    const includeLogs = options.includeLogs !== false
    const statuses = await this.workerStatuses(compact)
    const byUsername = new Map()
    for (const status of statuses) for (const bot of status.bots || []) byUsername.set(bot.username, bot)
    const bots = this.accounts.map(account => byUsername.get(account.username) || {
      username: account.username,
      state: 'durduruldu',
      desired: this.desiredNames.has(account.username),
      proxy: '-',
      ping: null,
      worldChanges: 0,
      lastError: '',
      position: null,
      dimension: ''
    })
    const counts = {}
    for (const bot of bots) counts[bot.state] = (counts[bot.state] || 0) + 1
    const sumStat = name => statuses.reduce((sum, status) => sum + Number(status.stats?.[name] || 0), 0)
    const now = Date.now()
    const instances = this.shardDefinitions.map(definition => {
      const status = statuses.find(item => item.instanceIndex === definition.index)
      return {
        id: definition.index + 1,
        running: Boolean(this.shards.get(definition.index) && !this.shards.get(definition.index).exited),
        accounts: definition.accounts.length,
        desired: this.localDesiredNames(definition).length,
        online: Number(status?.counts?.aktif || 0),
        connecting: Number(status?.counts?.baglaniyor || 0)
      }
    })
    const base = {
      running: this.running,
      entriesPaused: this.entriesPaused,
      queuedEntries: statuses.reduce((sum, status) => sum + Number(status.queuedEntries || 0), 0),
      desiredCount: this.desiredNames.size,
      startedAt: this.startedAt,
      counts,
      total: this.accounts.length,
      proxyCount: this.proxies.length,
      bots,
      logs: includeLogs ? this.logs.slice(compact ? -40 : -100).reverse() : [],
      memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      server: { host: this.config.server.host, port: this.config.server.port, version: this.config.server.version, loopbackOnly: false },
      fleet: { ...this.config.fleet, instanceSize: this.shardSize },
      optimizations: {
        deltaStatusUpdates: this.config.optimizations?.deltaStatusUpdates !== false,
        disableBotPhysics: this.config.optimizations?.disableBotPhysics !== false,
        globalConnectionQueue: this.globalQueueEnabled(),
        globalQueueWaiting: this.globalPermitQueue.length
      },
      bypass: {
        resourcePackHandling: this.config.bypass?.resourcePackHandling !== false,
        transferCompatibility: this.config.bypass?.transferCompatibility !== false
      },
      instances,
      activeInstances: instances.filter(instance => instance.running).length,
      broadcast: {
        running: statuses.some(status => status.broadcast?.running),
        sent: statuses.reduce((sum, status) => sum + Number(status.broadcast?.sent || 0), 0),
        total: statuses.reduce((sum, status) => sum + Number(status.broadcast?.total || 0), 0)
      },
      stats: { uptimeMs: this.startedAt ? Math.max(0, now - new Date(this.startedAt).getTime()) : 0 }
    }
    base.revision = this.trackStatusChanges(bots)
    if (compact) return base
    return {
      ...base,
      automation: {
        initial: this.config.commands.initial,
        onWorldChange: this.config.commands.onWorldChange,
        scheduledMessage: this.config.scheduledMessage,
        conditionalRules: this.config.conditionalRules,
        nextScheduledAt: statuses.map(status => status.automation?.nextScheduledAt).filter(Boolean).sort()[0] || null
      },
      workflowV2: this.config.workflowV2,
      groups: this.config.groups,
      reconnect: {
        autoReconnect: this.config.fleet.autoReconnect,
        reconnectBaseMs: this.config.fleet.reconnectBaseMs,
        reconnectMaxMs: this.config.fleet.reconnectMaxMs
      },
      plugins: this.pluginManager.status(),
      externalPlugins: statuses.flatMap(status => status.externalPlugins || []),
      memoryBudget: {
        enabled: this.pluginManager.isEnabled('memory-budget'),
        limitMb: this.pluginManager.getSettings('memory-budget').limitMb,
        reached: Math.round(process.memoryUsage().rss / 1024 / 1024) >= this.pluginManager.getSettings('memory-budget').limitMb
      },
      stats: {
        ...base.stats,
        connectionAttempts: sumStat('connectionAttempts'),
        successfulConnections: sumStat('successfulConnections'),
        proxyErrors: sumStat('proxyErrors'),
        reconnects: sumStat('reconnects'),
        kicks: sumStat('kicks'),
        disconnects: sumStat('disconnects'),
        commandsSent: sumStat('commandsSent'),
        broadcastSent: sumStat('broadcastSent'),
        successRate: sumStat('connectionAttempts') ? Math.round(sumStat('successfulConnections') / sumStat('connectionAttempts') * 1000) / 10 : 0,
        history: statuses.flatMap(status => status.stats?.history || []).sort((a, b) => a.time - b.time).slice(-180)
      }
    }
  }

  async dispose () {
    this.disposed = true
    this.clearGlobalPermits()
    this.desiredNames.clear()
    await Promise.all([...this.shards.values()].map(shard => this.stopShard(shard)))
  }
}

module.exports = { DEFAULT_SHARD_SIZE, ShardedBotManager, buildShardDefinitions, shardIndexForAccount }
