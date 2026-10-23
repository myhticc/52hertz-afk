'use strict'

function csvCell (value) {
  const text = String(value ?? '')
  return `"${text.replace(/"/g, '""')}"`
}

function formatLogs (logs, format) {
  const items = Array.isArray(logs) ? logs : []
  if (format === 'json') return JSON.stringify(items, null, 2) + '\n'
  if (format === 'csv') {
    const lines = ['time,level,username,message']
    for (const item of items) lines.push([item.time, item.level, item.username, item.message].map(csvCell).join(','))
    return lines.join('\n') + '\n'
  }
  if (format === 'txt') {
    return items.map(item => `${item.time}\t${String(item.level || 'info').toUpperCase()}\t${item.username || '-'}\t${item.message || ''}`).join('\n') + (items.length ? '\n' : '')
  }
  throw new Error('Log export format must be JSON, CSV, or TXT')
}

module.exports = { formatLogs }
