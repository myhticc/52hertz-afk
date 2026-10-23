'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const STORE_FILE = 'profiles.json'
const PROFILE_FILES = ['config.json', 'accounts.json', 'proxies.txt']
const EXPORT_FORMAT = 'minecraft-afk-launcher-profile'

function writeJsonAtomic (file, value) {
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
  fs.renameSync(temporary, file)
}

function normalizeName (raw) {
  const name = String(raw || '').replace(/[\u0000-\u001f\u007f]/g, '').trim()
  if (!name || name.length > 60) throw new Error('Instance name must contain 1-60 characters')
  return name
}

function normalizeId (raw) {
  const id = String(raw || '')
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) throw new Error('Invalid instance id')
  return id
}

function profilesRoot (dataDir) {
  return path.join(dataDir, 'profiles')
}

function profileDir (dataDir, rawId) {
  const id = normalizeId(rawId)
  const root = profilesRoot(dataDir)
  const target = path.join(root, id)
  if (path.dirname(target) !== root) throw new Error('Invalid instance path')
  return target
}

function readStore (dataDir) {
  const value = JSON.parse(fs.readFileSync(path.join(dataDir, STORE_FILE), 'utf8'))
  if (value?.version !== 1 || !Array.isArray(value.profiles) || !value.profiles.length) throw new Error('Instance registry is invalid')
  value.profiles = value.profiles.map(item => ({
    id: normalizeId(item.id),
    name: normalizeName(item.name),
    createdAt: String(item.createdAt || new Date().toISOString()),
    updatedAt: String(item.updatedAt || item.createdAt || new Date().toISOString())
  }))
  if (!value.profiles.some(item => item.id === value.activeId)) value.activeId = value.profiles[0].id
  return value
}

function saveStore (dataDir, store) {
  writeJsonAtomic(path.join(dataDir, STORE_FILE), store)
}

function copyProfileFiles (sourceDir, targetDir) {
  fs.mkdirSync(targetDir, { recursive: true, mode: 0o700 })
  for (const name of PROFILE_FILES) {
    const target = path.join(targetDir, name)
    fs.copyFileSync(path.join(sourceDir, name), target)
    fs.chmodSync(target, 0o600)
  }
}

function ensureProfileStore (dataDir) {
  fs.mkdirSync(profilesRoot(dataDir), { recursive: true, mode: 0o700 })
  const storeFile = path.join(dataDir, STORE_FILE)
  if (!fs.existsSync(storeFile)) {
    const now = new Date().toISOString()
    const target = profileDir(dataDir, 'default')
    copyProfileFiles(dataDir, target)
    saveStore(dataDir, { version: 1, activeId: 'default', profiles: [{ id: 'default', name: 'Default Instance', createdAt: now, updatedAt: now }] })
  }
  const store = readStore(dataDir)
  for (const profile of store.profiles) {
    const directory = profileDir(dataDir, profile.id)
    if (!fs.existsSync(directory)) throw new Error(`Instance data is missing: ${profile.name}`)
    for (const name of PROFILE_FILES) {
      const file = path.join(directory, name)
      if (!fs.existsSync(file)) throw new Error(`Instance file is missing: ${profile.name}/${name}`)
      fs.chmodSync(file, 0o600)
    }
  }
  return store
}

function generateId () {
  return `instance-${crypto.randomUUID().slice(0, 8)}`
}

function listProfiles (dataDir) {
  const store = readStore(dataDir)
  return store.profiles.map(profile => {
    const directory = profileDir(dataDir, profile.id)
    let server = { host: 'Unknown', port: 25565 }
    let accountCount = 0
    let proxyCount = 0
    try { server = JSON.parse(fs.readFileSync(path.join(directory, 'config.json'), 'utf8')).server || server } catch {}
    try { accountCount = JSON.parse(fs.readFileSync(path.join(directory, 'accounts.json'), 'utf8')).length || 0 } catch {}
    try { proxyCount = fs.readFileSync(path.join(directory, 'proxies.txt'), 'utf8').split(/\r?\n/).filter(line => line.trim() && !line.trim().startsWith('#')).length } catch {}
    return { ...profile, active: profile.id === store.activeId, server, accountCount, proxyCount }
  })
}

function createProfile (dataDir, rawName, sourceId) {
  const store = readStore(dataDir)
  const name = normalizeName(rawName)
  if (store.profiles.some(item => item.name.toLowerCase() === name.toLowerCase())) throw new Error('An instance with this name already exists')
  const source = profileDir(dataDir, sourceId || store.activeId)
  const id = generateId()
  const now = new Date().toISOString()
  copyProfileFiles(source, profileDir(dataDir, id))
  store.profiles.push({ id, name, createdAt: now, updatedAt: now })
  saveStore(dataDir, store)
  return id
}

function renameProfile (dataDir, rawId, rawName) {
  const store = readStore(dataDir)
  const id = normalizeId(rawId)
  const name = normalizeName(rawName)
  const profile = store.profiles.find(item => item.id === id)
  if (!profile) throw new Error('Instance was not found')
  if (store.profiles.some(item => item.id !== id && item.name.toLowerCase() === name.toLowerCase())) throw new Error('An instance with this name already exists')
  profile.name = name
  profile.updatedAt = new Date().toISOString()
  saveStore(dataDir, store)
}

function setActiveProfile (dataDir, rawId) {
  const store = readStore(dataDir)
  const id = normalizeId(rawId)
  if (!store.profiles.some(item => item.id === id)) throw new Error('Instance was not found')
  store.activeId = id
  saveStore(dataDir, store)
  return profileDir(dataDir, id)
}

function touchProfile (dataDir, rawId) {
  const store = readStore(dataDir)
  const profile = store.profiles.find(item => item.id === rawId)
  if (profile) {
    profile.updatedAt = new Date().toISOString()
    saveStore(dataDir, store)
  }
}

function deleteProfile (dataDir, rawId) {
  const store = readStore(dataDir)
  const id = normalizeId(rawId)
  if (store.profiles.length === 1) throw new Error('The final instance cannot be deleted')
  const index = store.profiles.findIndex(item => item.id === id)
  if (index < 0) throw new Error('Instance was not found')
  store.profiles.splice(index, 1)
  if (store.activeId === id) store.activeId = store.profiles[0].id
  saveStore(dataDir, store)
  const trashRoot = path.join(dataDir, 'profile-trash')
  fs.mkdirSync(trashRoot, { recursive: true, mode: 0o700 })
  fs.renameSync(profileDir(dataDir, id), path.join(trashRoot, `${id}-${Date.now()}`))
  return store.activeId
}

function buildExport (dataDir, rawId) {
  const store = readStore(dataDir)
  const id = normalizeId(rawId)
  const profile = store.profiles.find(item => item.id === id)
  if (!profile) throw new Error('Instance was not found')
  const directory = profileDir(dataDir, id)
  return {
    format: EXPORT_FORMAT,
    version: 1,
    exportedAt: new Date().toISOString(),
    profile: {
      name: profile.name,
      config: JSON.parse(fs.readFileSync(path.join(directory, 'config.json'), 'utf8')),
      accounts: JSON.parse(fs.readFileSync(path.join(directory, 'accounts.json'), 'utf8')),
      proxies: fs.readFileSync(path.join(directory, 'proxies.txt'), 'utf8')
    }
  }
}

function importProfile (dataDir, bundle, normalized) {
  if (bundle?.format !== EXPORT_FORMAT || bundle?.version !== 1 || !bundle.profile) throw new Error('This is not a supported AFK Launcher instance file')
  const store = readStore(dataDir)
  let name = normalizeName(bundle.profile.name || 'Imported Instance')
  const baseName = name
  let suffix = 2
  while (store.profiles.some(item => item.name.toLowerCase() === name.toLowerCase())) name = `${baseName} ${suffix++}`.slice(0, 60)
  const id = generateId()
  const directory = profileDir(dataDir, id)
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  writeJsonAtomic(path.join(directory, 'config.json'), normalized.config)
  writeJsonAtomic(path.join(directory, 'accounts.json'), normalized.accounts)
  fs.writeFileSync(path.join(directory, 'proxies.txt'), normalized.proxies, { mode: 0o600 })
  const now = new Date().toISOString()
  store.profiles.push({ id, name, createdAt: now, updatedAt: now })
  store.activeId = id
  saveStore(dataDir, store)
  return id
}

module.exports = {
  EXPORT_FORMAT,
  PROFILE_FILES,
  buildExport,
  createProfile,
  deleteProfile,
  ensureProfileStore,
  importProfile,
  listProfiles,
  profileDir,
  readStore,
  renameProfile,
  setActiveProfile,
  touchProfile
}
