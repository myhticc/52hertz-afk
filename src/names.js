'use strict'

const crypto = require('node:crypto')

const first = ['Nova', 'Pixel', 'Shadow', 'Turbo', 'Frost', 'Neon', 'Blaze', 'Cosmic', 'Ghost', 'Storm', 'Lunar', 'Rapid', 'Crimson', 'Silent', 'Hyper', 'Aqua', 'Iron', 'Lucky', 'Wild', 'Sky']
const second = ['Wolf', 'Raven', 'Panda', 'Falcon', 'Tiger', 'Otter', 'Knight', 'Ninja', 'Comet', 'Viper', 'Moose', 'Gecko', 'Bison', 'Fox', 'Bear', 'Cobra', 'Lynx', 'Droid', 'Wisp', 'Yak']

function randomName () {
  const a = first[crypto.randomInt(first.length)]
  const b = second[crypto.randomInt(second.length)]
  const digits = String(crypto.randomInt(10, 1000))
  return `${a}${b}${digits}`.slice(0, 16)
}

function generateUniqueNames (count) {
  if (!Number.isInteger(count) || count < 1 || count > 500) throw new Error('Count must be between 1 and 500')
  const names = new Set()
  while (names.size < count) names.add(randomName())
  return [...names]
}

module.exports = { generateUniqueNames, randomName }
