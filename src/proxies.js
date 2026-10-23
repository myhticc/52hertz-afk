'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { ROOT } = require('./config')

function parsePort (value) {
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid proxy port: ${value}`)
  return port
}

function parseProxy (rawLine) {
  const line = rawLine.trim()
  if (!line || line.startsWith('#')) return null

  if (/^socks5:\/\//i.test(line)) {
    const url = new URL(line)
    if (url.protocol !== 'socks5:') throw new Error('Only SOCKS5 proxies are supported')
    return {
      host: url.hostname,
      port: parsePort(url.port),
      userId: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      label: `${url.hostname}:${url.port}`
    }
  }

  const parts = line.split(':')
  if (parts.length === 2 || parts.length === 4) {
    const [host, port, userId = '', password = ''] = parts
    if (!host) throw new Error('Proxy host cannot be empty')
    return { host, port: parsePort(port), userId, password, label: `${host}:${port}` }
  }

  const at = line.lastIndexOf('@')
  if (at > 0) {
    const credentials = line.slice(0, at).split(':')
    const address = line.slice(at + 1).split(':')
    if (credentials.length === 2 && address.length === 2) {
      return {
        host: address[0],
        port: parsePort(address[1]),
        userId: credentials[0],
        password: credentials[1],
        label: `${address[0]}:${address[1]}`
      }
    }
  }
  throw new Error(`Unrecognized proxy format: ${line}`)
}

function parseProxyText (text) {
  const proxies = []
  const errors = []
  text.split(/\r?\n/).forEach((line, index) => {
    try {
      const proxy = parseProxy(line)
      if (proxy) proxies.push(proxy)
    } catch (error) {
      errors.push(`Line ${index + 1}: ${error.message}`)
    }
  })
  if (errors.length) throw new Error(errors.slice(0, 10).join('; '))
  return proxies
}

function loadProxies (fileName = 'proxies.txt', baseDir = ROOT) {
  const file = path.join(baseDir, fileName)
  if (!fs.existsSync(file)) return []
  return parseProxyText(fs.readFileSync(file, 'utf8'))
}

function assignProxyPools (accounts, proxies, perAccount = 3) {
  if (proxies.length === 0) return accounts.map(() => [])
  if (proxies.length < perAccount) throw new Error(`At least ${perAccount} proxies are required; the file contains ${proxies.length}`)
  return accounts.map((_, index) => Array.from(
    { length: perAccount },
    (_, offset) => proxies[((index * perAccount) + offset) % proxies.length]
  ))
}

module.exports = { assignProxyPools, loadProxies, parseProxy, parseProxyText }
