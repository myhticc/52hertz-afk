'use strict'

const dns = require('node:dns/promises')
const net = require('node:net')

function pickSrv (records) {
  return [...records].sort((a, b) => (a.priority - b.priority) || (b.weight - a.weight))[0]
}

async function resolveMinecraftTarget (host, port, dnsApi = dns) {
  const originalHost = String(host).trim()
  let targetHost = originalHost
  let targetPort = Number(port)
  let usedSrv = false

  if (targetPort === 25565 && net.isIP(originalHost) === 0 && originalHost.toLowerCase() !== 'localhost') {
    try {
      const records = await dnsApi.resolveSrv(`_minecraft._tcp.${originalHost}`)
      if (records.length) {
        const selected = pickSrv(records)
        targetHost = selected.name.replace(/\.$/, '')
        targetPort = selected.port
        usedSrv = true
      }
    } catch {}
  }

  if (net.isIP(targetHost) === 0 && targetHost.toLowerCase() !== 'localhost') {
    try {
      const addresses = await dnsApi.lookup(targetHost, { all: true, verbatim: false })
      const preferred = addresses.find(item => item.family === 4) || addresses[0]
      if (preferred?.address) targetHost = preferred.address
    } catch {}
  }

  return {
    connectHost: targetHost,
    connectPort: targetPort,
    handshakeHost: originalHost,
    usedSrv
  }
}

module.exports = { pickSrv, resolveMinecraftTarget }
