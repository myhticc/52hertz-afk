'use strict'

const { parentPort, workerData } = require('node:worker_threads')
const { BotManager } = require('./bot-manager')

if (!parentPort) throw new Error('bot-worker must run inside a worker thread')

let nextPermitId = 1
const pendingPermits = new Map()

const manager = new BotManager(workerData.config, workerData.accounts, workerData.proxies, {
  requestConnectionPermit: username => new Promise(resolve => {
    const permitId = nextPermitId++
    pendingPermits.set(permitId, resolve)
    parentPort.postMessage({ type: 'permit-request', permitId, username })
  })
})

manager.on('log', item => parentPort.postMessage({ type: 'log', item }))
manager.on('log:update', item => parentPort.postMessage({ type: 'log:update', item }))

const allowedMethods = new Set([
  'activitySince',
  'botDetails',
  'pauseEntries',
  'queueBroadcast',
  'reconnectFailed',
  'restartBot',
  'resumeEntries',
  'retryBot',
  'sendBotChat',
  'start',
  'startOnly',
  'status',
  'stop',
  'stopBot',
  'stopCount',
  'toggleEntriesPaused',
  'updateAutomation',
  'updateBypass',
  'updateGroups',
  'updateOptimizations',
  'updatePlugins',
  'updateReconnectPolicy',
  'updateWorkflowV2'
])

parentPort.on('message', async message => {
  if (message?.type === 'permit-grant') {
    const resolve = pendingPermits.get(message.permitId)
    if (resolve) {
      pendingPermits.delete(message.permitId)
      resolve()
    }
    return
  }
  const { id, method, args = [] } = message || {}
  if (!Number.isSafeInteger(id) || !allowedMethods.has(method)) return
  try {
    const result = await manager[method](...args)
    parentPort.postMessage({ type: 'result', id, result })
  } catch (error) {
    parentPort.postMessage({ type: 'result', id, error: error?.message || String(error) })
  }
})

parentPort.postMessage({ type: 'ready' })
