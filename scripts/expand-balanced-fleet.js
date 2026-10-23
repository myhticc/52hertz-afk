'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { randomName } = require('../src/names')
const { parseProxyText } = require('../src/proxies')

const dataDir = path.resolve(process.argv[2] || '.')
const requestedTotal = Number(process.argv[3] || 500)
const preserveCount = Number(process.argv[4] || 300)
const maxPrimaryPerCredential = Number(process.argv[5] || 5)

if (!Number.isInteger(requestedTotal) || requestedTotal < 1 || requestedTotal > 500) throw new Error('Account total must be between 1 and 500')
if (!Number.isInteger(preserveCount) || preserveCount < 0 || preserveCount > requestedTotal) throw new Error('Preserved account count is invalid')
if (!Number.isInteger(maxPrimaryPerCredential) || maxPrimaryPerCredential < 1) throw new Error('Primary proxy capacity is invalid')

function writeAtomic (file, content) {
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(temporary, content, { mode: 0o600 })
  fs.renameSync(temporary, file)
  fs.chmodSync(file, 0o600)
}

const accountFile = path.join(dataDir, 'accounts.json')
const proxyFile = path.join(dataDir, 'proxies.txt')
const configFile = path.join(dataDir, 'config.json')
const installedAccounts = JSON.parse(fs.readFileSync(accountFile, 'utf8'))
const accounts = installedAccounts.slice(0, preserveCount).map(account => ({ username: String(account.username || '').trim() }))
const names = new Set(accounts.map(account => account.username.toLowerCase()))
if (names.size !== accounts.length || [...names].some(name => !/^[a-z0-9_]{3,16}$/i.test(name))) throw new Error('Installed account names are invalid or duplicated')
while (accounts.length < requestedTotal) {
  const username = randomName()
  if (names.has(username.toLowerCase())) continue
  names.add(username.toLowerCase())
  accounts.push({ username })
}

const sourceLines = fs.readFileSync(proxyFile, 'utf8').split(/\s+/).map(value => value.trim()).filter(Boolean)
const uniqueLines = [...new Set(sourceLines)]
parseProxyText(uniqueLines.join('\n'))
if (uniqueLines.length < 3) throw new Error('At least three unique proxy credentials are required')
if (uniqueLines.length * maxPrimaryPerCredential < requestedTotal) {
  throw new Error(`${requestedTotal} accounts require at least ${Math.ceil(requestedTotal / maxPrimaryPerCredential)} unique primary proxy credentials`)
}

const firstShift = Math.max(1, Math.floor(uniqueLines.length / 3))
const secondShift = Math.max(firstShift + 1, Math.floor(uniqueLines.length * 2 / 3))
const proxyLines = []
const primaryCounts = new Map()
for (let index = 0; index < accounts.length; index += 1) {
  const primary = uniqueLines[index % uniqueLines.length]
  const backupOne = uniqueLines[(index + firstShift) % uniqueLines.length]
  const backupTwo = uniqueLines[(index + secondShift) % uniqueLines.length]
  if (new Set([primary, backupOne, backupTwo]).size !== 3) throw new Error(`Account ${index + 1} did not receive three distinct proxy credentials`)
  proxyLines.push(primary, backupOne, backupTwo)
  primaryCounts.set(primary, (primaryCounts.get(primary) || 0) + 1)
}
const highestPrimaryUse = Math.max(...primaryCounts.values())
if (highestPrimaryUse > maxPrimaryPerCredential) throw new Error(`A primary proxy was assigned ${highestPrimaryUse} accounts`)

const config = JSON.parse(fs.readFileSync(configFile, 'utf8'))
config.fleet.accountCount = requestedTotal
config.fleet.proxiesPerAccount = 3
if (config.plugins?.['memory-budget']?.settings) config.plugins['memory-budget'].settings.limitMb = 9216

const accountText = JSON.stringify(accounts, null, 2) + '\n'
const proxyText = proxyLines.join('\n') + '\n'
const configText = JSON.stringify(config, null, 2) + '\n'
writeAtomic(accountFile, accountText)
writeAtomic(proxyFile, proxyText)
writeAtomic(configFile, configText)

const defaultProfile = path.join(dataDir, 'profiles', 'default')
if (fs.existsSync(defaultProfile)) {
  writeAtomic(path.join(defaultProfile, 'accounts.json'), accountText)
  writeAtomic(path.join(defaultProfile, 'proxies.txt'), proxyText)
  writeAtomic(path.join(defaultProfile, 'config.json'), configText)
}

console.log(JSON.stringify({
  accounts: accounts.length,
  preserved: preserveCount,
  added: accounts.length - preserveCount,
  proxyRecords: proxyLines.length,
  uniqueProxyCredentials: uniqueLines.length,
  proxiesPerAccount: 3,
  highestPrimaryUse,
  memoryLimitMb: config.plugins?.['memory-budget']?.settings?.limitMb
}, null, 2))
