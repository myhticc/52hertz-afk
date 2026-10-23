'use strict'

const fs = require('node:fs')
const path = require('node:path')

const ID_PATTERN = /^[a-z][a-z0-9-]{1,63}$/

class ExternalPluginManager {
  constructor (root, settings = {}, logger = () => {}) {
    this.root = root
    this.settings = settings || {}
    this.logger = logger
    this.plugins = []
    fs.mkdirSync(root, { recursive: true, mode: 0o700 })
    this.load()
  }

  load () {
    this.dispose()
    this.plugins = []
    for (const entry of fs.readdirSync(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const directory = path.join(this.root, entry.name)
      const manifestFile = path.join(directory, 'plugin.json')
      if (!fs.existsSync(manifestFile)) continue
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
        if (!ID_PATTERN.test(manifest.id || '') || manifest.id !== entry.name) throw new Error('manifest id must match the folder name')
        const main = String(manifest.main || 'index.js')
        if (path.basename(main) !== main || !main.endsWith('.js')) throw new Error('main must be a JavaScript filename inside the plugin folder')
        const configured = this.settings[manifest.id] || {}
        const plugin = {
          id: manifest.id,
          name: String(manifest.name || manifest.id),
          version: String(manifest.version || '1.0.0'),
          description: String(manifest.description || ''),
          permissions: Array.isArray(manifest.permissions) ? manifest.permissions.map(String) : [],
          enabled: configured.enabled === true,
          settings: configured.settings && typeof configured.settings === 'object' ? configured.settings : {},
          directory,
          main,
          hooks: null,
          error: ''
        }
        this.plugins.push(plugin)
        if (plugin.enabled) this.activate(plugin)
      } catch (error) {
        this.plugins.push({ id: entry.name, name: entry.name, version: '?', description: '', permissions: [], enabled: false, settings: {}, hooks: null, error: error.message })
        this.logger('error', `External plugin ${entry.name} could not be loaded: ${error.message}`)
      }
    }
  }

  activate (plugin) {
    const mainFile = path.join(plugin.directory, plugin.main)
    if (!fs.existsSync(mainFile)) throw new Error(`Plugin entry file is missing: ${plugin.main}`)
    try {
      delete require.cache[require.resolve(mainFile)]
      const factory = require(mainFile)
      if (typeof factory !== 'function') throw new Error('Plugin must export a setup function')
      const api = Object.freeze({
        id: plugin.id,
        settings: Object.freeze({ ...plugin.settings }),
        log: (level, message) => this.logger(String(level || 'info'), `[${plugin.name}] ${String(message || '')}`)
      })
      const hooks = factory(api) || {}
      if (typeof hooks !== 'object' || Array.isArray(hooks)) throw new Error('Plugin setup must return a hook object')
      plugin.hooks = hooks
      plugin.error = ''
      if (typeof hooks.onEnable === 'function') Promise.resolve(hooks.onEnable()).catch(error => this.fail(plugin, 'onEnable', error))
      this.logger('success', `External plugin loaded: ${plugin.name} v${plugin.version}`)
    } catch (error) {
      plugin.hooks = null
      plugin.error = error.message
      this.logger('error', `External plugin ${plugin.name} failed: ${error.message}`)
    }
  }

  fail (plugin, hook, error) {
    plugin.error = `${hook}: ${error.message || error}`
    this.logger('error', `External plugin ${plugin.name} ${hook} failed: ${error.message || error}`)
  }

  emitHook (hook, contextFactory) {
    for (const plugin of this.plugins) {
      const handler = plugin.enabled && plugin.hooks?.[hook]
      if (typeof handler !== 'function') continue
      try {
        Promise.resolve(handler(contextFactory(plugin))).catch(error => this.fail(plugin, hook, error))
      } catch (error) {
        this.fail(plugin, hook, error)
      }
    }
  }

  status () {
    return this.plugins.map(({ id, name, version, description, permissions, enabled, settings, error }) => ({ id, name, version, description, permissions, enabled, settings, error }))
  }

  dispose () {
    for (const plugin of this.plugins || []) {
      if (typeof plugin.hooks?.onDisable === 'function') {
        try { plugin.hooks.onDisable() } catch {}
      }
    }
  }
}

module.exports = { ExternalPluginManager }
