# AFK Launcher JavaScript Plugin API

External plugins are trusted local JavaScript programs. They run with the same operating-system permissions as the launcher, so install only code you have reviewed.

## Installation

1. Open **Plugins → External JavaScript Plugins → Open folder**.
2. Create one directory per plugin. The directory name must match the manifest id.
3. Add `plugin.json` and `index.js`.
4. Press **Reload**, review the detected plugin, and enable it. New plugins are disabled by default.

Example manifest:

```json
{
  "id": "hello-afk",
  "name": "Hello AFK",
  "version": "1.0.0",
  "description": "Example event plugin",
  "main": "index.js",
  "permissions": ["bot.chat"]
}
```

Example entry point:

```js
'use strict'

module.exports = api => ({
  onEnable () {
    api.log('info', 'Plugin enabled')
  },
  onSpawn (bot) {
    api.log('info', `${bot.username} joined`)
  },
  onChat (bot) {
    if (bot.message.toLowerCase().includes('hello')) bot.chat('Hello!')
  }
})
```

## Hooks

- `onEnable()`
- `onDisable()`
- `onBotCreated(context)`
- `onSpawn(context)`
- `onChat(context)`
- `onHealth(context)`
- `onDeath(context)`
- `onWorldChange(context)`
- `onKicked(context)`
- `onError(context)`
- `onDisconnect(context)`

Every bot context includes `event`, `username`, and `getState()`. Event-specific fields include `message`, `position`, `signal`, `reason`, or `error`.

## Permission-gated methods

- `bot.chat`: `context.chat(message)`
- `bot.respawn`: `context.respawn()`
- `bot.inventory.read`: `context.inventory()`
- `bot.raw`: `context.rawBot` for advanced Mineflayer access

The permission list documents and gates launcher API methods, but it is not an operating-system security sandbox.
