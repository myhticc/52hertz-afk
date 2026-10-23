'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { randomName } = require('../src/names')
const { assignProxyPools, parseProxyText } = require('../src/proxies')

const root = path.resolve(__dirname, '..')
const proxySource = process.argv[2]
const requestedTotal = Number(process.argv[3] || 300)
const preserveCount = process.argv[4] == null ? null : Number(process.argv[4])

if (!proxySource) throw new Error('Usage: update-fleet-data.js <proxy-source> [total-accounts]')
if (!Number.isInteger(requestedTotal) || requestedTotal < 1 || requestedTotal > 500) {
  throw new Error('Account total must be between 1 and 500')
}
if (preserveCount != null && (!Number.isInteger(preserveCount) || preserveCount < 0 || preserveCount > requestedTotal)) {
  throw new Error('Preserved account count must be between 0 and the requested total')
}

function writeAtomic (file, content) {
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(temporary, content, { mode: 0o600 })
  fs.renameSync(temporary, file)
  fs.chmodSync(file, 0o600)
}

function readAccounts (file) {
  const accounts = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (!Array.isArray(accounts)) throw new Error(`${file} must contain an array`)
  return accounts.map(account => ({ username: String(account?.username || '').trim() }))
}

function expandAccounts (accounts, total) {
  const names = new Set(accounts.map(account => account.username))
  if (names.has('')) throw new Error('An installed account has an empty username')
  if (names.size !== accounts.length) throw new Error('Installed account names must be unique')
  while (accounts.length < total) {
    const username = randomName()
    if (names.has(username)) continue
    names.add(username)
    accounts.push({ username })
  }
  return accounts.slice(0, total)
}

function updateConfig (file, total) {
  const config = JSON.parse(fs.readFileSync(file, 'utf8'))
  config.fleet.accountCount = total
  config.fleet.proxiesPerAccount = 3
  writeAtomic(file, JSON.stringify(config, null, 2) + '\n')
}

const rawProxyText = fs.readFileSync(path.resolve(proxySource), 'utf8')
const normalizedProxyText = rawProxyText.split(/\s+/).map(value => value.trim()).filter(Boolean).join('\n') + '\n'
const proxies = parseProxyText(normalizedProxyText)
if (proxies.length < 3) throw new Error('At least three proxy records are required')

const installedAccounts = readAccounts(path.join(root, 'accounts.json'))
const accounts = expandAccounts(preserveCount == null ? installedAccounts : installedAccounts.slice(0, preserveCount), requestedTotal)
const pools = assignProxyPools(accounts, proxies, 3)
if (pools.length !== requestedTotal || pools.some(pool => pool.length !== 3)) {
  throw new Error('Three-proxy pool validation failed')
}

const accountText = JSON.stringify(accounts, null, 2) + '\n'
for (const directory of [root, path.join(root, 'profiles', 'default')]) {
  writeAtomic(path.join(directory, 'accounts.json'), accountText)
  writeAtomic(path.join(directory, 'proxies.txt'), normalizedProxyText)
  updateConfig(path.join(directory, 'config.json'), requestedTotal)
}

console.log(`Accounts: ${accounts.length} (${new Set(accounts.map(account => account.username)).size} unique; ${preserveCount == null ? installedAccounts.length : preserveCount} preserved)`)
console.log(`Proxy records: ${proxies.length} (${new Set(normalizedProxyText.trim().split(/\n/)).size} unique credentials)`)
console.log(`Proxy slots: ${pools.reduce((sum, pool) => sum + pool.length, 0)} (${pools[0].length} per account)`)
console.log('No proxy connections were attempted.')
