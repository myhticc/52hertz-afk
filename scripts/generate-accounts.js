'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { generateUniqueNames } = require('../src/names')

const count = Number(process.argv[2] || 300)
const target = path.resolve(__dirname, '..', 'accounts.json')
const accounts = generateUniqueNames(count).map(username => ({ username }))
fs.writeFileSync(target, JSON.stringify(accounts, null, 2) + '\n')
console.log(`${accounts.length} unique accounts written to: ${target}`)
