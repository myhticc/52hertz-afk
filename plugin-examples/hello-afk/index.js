'use strict'

module.exports = api => ({
  onEnable () {
    api.log('info', 'Hello AFK example enabled')
  },
  onSpawn (bot) {
    api.log('info', `${bot.username} joined the server`)
  },
  onChat (bot) {
    if (bot.message.toLowerCase().includes('hello bot')) bot.chat('Hello!')
  }
})
