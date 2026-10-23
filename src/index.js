'use strict'

const { loadAccounts, loadConfig } = require('./config')
const { loadProxies } = require('./proxies')
const { ShardedBotManager } = require('./sharded-bot-manager')
const { createDashboard } = require('./dashboard')

function main () {
  const config = loadConfig()
  const accounts = loadAccounts()
  const proxies = loadProxies()
  if (accounts.length < config.fleet.accountCount) throw new Error(`Config requests ${config.fleet.accountCount} accounts, but accounts.json contains ${accounts.length}`)

  const manager = new ShardedBotManager(config, accounts, proxies, { shardSize: 50 })
  const dashboard = createDashboard(config, manager)
  dashboard.on('error', error => {
    console.error(`Panel error: ${error.message}`)
    process.exitCode = 1
  })
  dashboard.listen(config.dashboard.port, config.dashboard.host, () => {
    const url = `http://${config.dashboard.host}:${config.dashboard.port}`
    console.log(`\nMinecraft AFK Launcher ready: ${url}`)
    console.log(`Accounts: ${config.fleet.accountCount} | Proxies: ${proxies.length} | Target: ${config.server.host}:${config.server.port}`)
    console.log('We recommend starting with the 5 Bot Test from the panel.\n')
  })

  const shutdown = () => {
    manager.dispose().catch(error => console.error(`Shutdown error: ${error.message}`))
    dashboard.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 2000).unref()
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}

try { main() } catch (error) {
  console.error(`Startup error: ${error.message}`)
  process.exitCode = 1
}
