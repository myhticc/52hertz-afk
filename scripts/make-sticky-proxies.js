'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { parseProxyText, assignProxyPools } = require('../src/proxies')

const root = path.resolve(__dirname, '..')
const accountFile = path.join(root, 'accounts.json')
const proxyFile = path.join(root, 'proxies.txt')
const accounts = JSON.parse(fs.readFileSync(accountFile, 'utf8'))
const sourceLines = fs.readFileSync(proxyFile, 'utf8').split(/\s+/).map(value => value.trim()).filter(Boolean)

if (!accounts.length || accounts.length > 500) throw new Error('Account list must contain 1-500 accounts')
if (!sourceLines.length) throw new Error('Proxy list is empty')

const [host, port, rawUsername, ...passwordParts] = sourceLines[0].split(':')
const password = passwordParts.join(':')
if (!host || !port || !rawUsername || !password) throw new Error('Expected HOST:PORT:USER:PASS proxy format')

const stickySuffix = rawUsername.match(/^(.*?)(?:-session-\d+)?-ttl-(\d+)$/i)
if (!stickySuffix) throw new Error('Proxy username does not contain a supported TTL suffix')
const username = stickySuffix[1]
const ttlSeconds = Number(stickySuffix[2])
if (!username || !Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1) throw new Error('Proxy TTL is invalid')

const perAccount = 3
const required = accounts.length * perAccount
const lines = Array.from({ length: required }, (_, index) => {
  const sessionId = String(100_000 + index).padStart(6, '0')
  return `${host}:${port}:${username}-session-${sessionId}-ttl-${ttlSeconds}:${password}`
})
const text = lines.join('\n') + '\n'
const proxies = parseProxyText(text)
const pools = assignProxyPools(accounts, proxies, perAccount)

if (new Set(lines).size !== required) throw new Error('Sticky session credentials are not unique')
if (pools.length !== accounts.length || pools.some(pool => pool.length !== perAccount)) throw new Error('Proxy pool validation failed')

function writeAtomic (file) {
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(temporary, text, { mode: 0o600 })
  fs.renameSync(temporary, file)
  fs.chmodSync(file, 0o600)
}

writeAtomic(proxyFile)
writeAtomic(path.join(root, 'profiles', 'default', 'proxies.txt'))

console.log(`Sticky proxy sessions: ${lines.length}`)
console.log(`Accounts: ${accounts.length}; sessions per account: ${perAccount}; TTL: ${ttlSeconds} seconds`)
console.log('No proxy connections were attempted.')
