'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const http = require('node:http')
const net = require('node:net')
const path = require('node:path')
const querystring = require('node:querystring')
const QRCode = require('qrcode')
const { loadAccounts, normalizeAutomationSettings, validateConfig } = require('./config')
const { normalizePlugins } = require('./plugin-manager')
const { parseProxyText } = require('./proxies')
const { dashboardPage: webDashboardPage } = require('./web-ui')

const SESSION_IDLE_TTL_MS = 30 * 60 * 1000
const SESSION_ABSOLUTE_TTL_MS = 12 * 60 * 60 * 1000
const PENDING_TTL_MS = 5 * 60 * 1000
const SESSION_COOKIE = '__Host-afk_session'
const PENDING_COOKIE = '__Host-afk_pending'
const IP_FAILURE_LIMIT = 8
const GLOBAL_FAILURE_LIMIT = 40
const sessions = new Map()
const pendingSessions = new Map()
const attempts = new Map()

function securityHeaders (contentType, scriptNonce = '') {
  return {
    'cache-control': 'no-store',
    'content-type': contentType,
    'content-security-policy': `default-src 'self'; style-src 'self' 'unsafe-inline'; script-src ${scriptNonce ? `'nonce-${scriptNonce}'` : "'none'"}; connect-src 'self'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; upgrade-insecure-requests`,
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'x-permitted-cross-domain-policies': 'none'
  }
}

function pageShell (body, title = 'AFK Control') {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>
:root{color-scheme:dark;--bg:#0c0d0e;--panel:#17191b;--soft:#202326;--line:#303438;--text:#f1f3f4;--muted:#969ca3;--green:#56c68d;--red:#ed6a72;--amber:#e9b45f;--blue:#6f95ff}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.45 Inter,ui-sans-serif,system-ui,-apple-system,sans-serif}button,input,textarea{font:inherit}.btn{border:1px solid var(--line);border-radius:8px;background:#222528;color:var(--text);padding:9px 13px;font-weight:650;cursor:pointer}.btn:hover{border-color:#565c62}.primary{background:#f2f3f4;color:#111;border-color:#f2f3f4}.danger{color:#ff9ba1}.wrap{min-height:100vh}.sidebar{position:fixed;inset:0 auto 0 0;width:230px;padding:22px 14px;border-right:1px solid var(--line);background:#111314}.brand{font-size:17px;font-weight:800;padding:0 9px 24px}.brand span{display:block;color:var(--muted);font-size:11px;font-weight:500;margin-top:3px}.nav{display:grid;gap:4px}.nav button{border:0;border-radius:7px;background:transparent;color:var(--muted);padding:10px;text-align:left;cursor:pointer}.nav button.active,.nav button:hover{background:#222527;color:var(--text)}.sidebottom{position:absolute;left:14px;right:14px;bottom:18px;color:var(--muted);font-size:12px}.main{margin-left:230px;padding:26px 30px;max-width:1700px}.top{display:flex;justify-content:space-between;gap:20px;align-items:center;margin-bottom:20px}.top h1{font-size:23px;margin:0}.target{color:var(--muted);margin-top:4px}.controls{display:flex;gap:7px;flex-wrap:wrap}.controls input{width:85px}.field,input,textarea{border:1px solid var(--line);border-radius:8px;background:#121415;color:var(--text);padding:9px 11px;outline:none}input:focus,textarea:focus{border-color:#707780}.metrics{display:grid;grid-template-columns:repeat(6,minmax(115px,1fr));gap:10px}.metric,.card{border:1px solid var(--line);border-radius:11px;background:var(--panel)}.metric{padding:15px}.label{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.07em}.value{font-size:25px;font-weight:760;margin-top:3px}.grid{display:grid;grid-template-columns:minmax(500px,1.5fr) minmax(330px,1fr);gap:12px;margin-top:12px}.cardhead{display:flex;justify-content:space-between;align-items:center;padding:13px 15px;border-bottom:1px solid var(--line);font-weight:700}.scroll{overflow:auto;height:530px}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:9px 12px;border-bottom:1px solid #272a2d;white-space:nowrap;font-size:12px}th{position:sticky;top:0;background:#1d2022;color:var(--muted);z-index:1}.badge{padding:3px 7px;border-radius:99px;background:#292d30}.aktif{background:#183b2a;color:#78dca4}.baglaniyor{background:#40351f;color:#ffd17d}.hata,.atildi{background:#48272b;color:#ffadb2}.log{padding:9px 13px;border-bottom:1px solid #272a2d;font-size:12px}.time{color:#6e757c}.who{color:#9db5ff;font-weight:700}.errorText{color:#ff9ca3}.composer{display:flex;gap:7px;padding:12px;border-top:1px solid var(--line)}.composer input{flex:1}.notice{min-height:21px;color:var(--amber);margin:10px 0}.hidden{display:none}.loginbody{min-height:100vh;display:grid;place-items:center;background:radial-gradient(circle at 50% 0,#212529 0,var(--bg) 42%)}.login{width:min(390px,92vw);border:1px solid var(--line);border-radius:15px;background:var(--panel);padding:28px;box-shadow:0 24px 80px #0008}.login h1{margin:0 0 6px;font-size:22px}.login p{color:var(--muted);margin:0 0 22px}.login label{display:block;color:var(--muted);font-size:12px;margin:12px 0 6px}.login input{width:100%}.login .btn{width:100%;margin-top:18px}.login .error{color:#ff9ca3;margin-top:14px}.login small{display:block;color:#6f757b;margin-top:18px}@media(max-width:980px){.sidebar{display:none}.main{margin:0;padding:18px}.metrics{grid-template-columns:repeat(3,1fr)}.grid{grid-template-columns:1fr}.scroll{height:430px}.top{align-items:flex-start;flex-direction:column}}@media(max-width:560px){.metrics{grid-template-columns:repeat(2,1fr)}.controls{width:100%}.grid{display:block}.card{margin-top:10px}}
</style></head><body>${body}</body></html>`
}

function loginPage (failed = false) {
  return pageShell(`<div class="loginbody"><form class="login" method="post" action="/login"><h1>Minecraft AFK Control</h1><p>Sign in to manage the private launcher instance.</p><label>Username</label><input name="username" autocomplete="username" required maxlength="64"><label>Password</label><input name="password" type="password" autocomplete="current-password" required maxlength="256"><button class="btn primary" type="submit">Sign in</button>${failed ? '<div class="error">Incorrect username or password.</div>' : ''}<small>Protected control panel · 52hertz AFK</small></form></div>`, 'Sign in · AFK Control')
}

function twoFactorPage ({ failed = false, setup = false, qrSvg = '', secret = '' } = {}) {
  const setupContent = setup
    ? `<div style="padding:14px;margin:14px 0;border:1px solid var(--line);border-radius:10px;background:#111314"><strong>Set up Authenticator</strong><p style="margin:7px 0 12px">Scan this QR code with Google Authenticator, Microsoft Authenticator, Authy or another TOTP app.</p><div style="display:grid;place-items:center;background:#fff;border-radius:10px;padding:8px;margin:auto;width:226px">${qrSvg}</div><label>Manual setup key</label><input value="${secret}" readonly autocomplete="off" style="font-family:monospace;letter-spacing:.08em"></div>`
    : '<p>Enter the current 6-digit code from your Authenticator app.</p>'
  return pageShell(`<div class="loginbody"><form class="login" method="post" action="/two-factor"><h1>Two-factor authentication</h1>${setupContent}<label>6-digit code</label><input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" minlength="6" maxlength="6" required autofocus><button class="btn primary" type="submit">Verify code</button>${failed ? '<div class="error">The code is incorrect or has expired.</div>' : ''}<small>The code changes every 30 seconds.</small></form></div>`, 'Two-factor authentication · AFK Control')
}

function dashboardPage (csrf, config) {
  const boot = JSON.stringify({ csrf, maxBots: config.fleet.accountCount }).replace(/</g, '\\u003c')
  return pageShell(`<div class="wrap"><aside class="sidebar"><div class="brand">AFK CONTROL<span>Debian 13 · Private instance</span></div><div class="nav"><button class="active">▣ Overview</button><button id="navBots">◎ Accounts</button><button id="navLogs">≡ Activity</button></div><div class="sidebottom"><div id="sideState">Service online</div><form method="post" action="/logout"><input type="hidden" name="csrf" value="${csrf}"><button class="btn" style="width:100%;margin-top:10px">Sign out</button></form></div></aside><main class="main"><div class="top"><div><h1>Fleet Overview</h1><div class="target" id="target">Loading server…</div></div><div class="controls"><input id="amount" type="number" min="1" max="${config.fleet.accountCount}" value="30"><button class="btn primary" id="start">Start selected</button><button class="btn" id="startAll">Start all</button><button class="btn" id="retry">Retry failed</button><button class="btn danger" id="stop">Stop all</button></div></div><div class="notice" id="notice">Ready. Bots are not started automatically.</div><section class="metrics"><div class="metric"><div class="label">Online</div><div class="value" id="active">0</div></div><div class="metric"><div class="label">Connecting</div><div class="value" id="connecting">0</div></div><div class="metric"><div class="label">Errors</div><div class="value" id="failed">0</div></div><div class="metric"><div class="label">Accounts</div><div class="value" id="total">${config.fleet.accountCount}</div></div><div class="metric"><div class="label">Proxies</div><div class="value" id="proxy">0</div></div><div class="metric"><div class="label">Memory</div><div class="value"><span id="memory">0</span><small> MB</small></div></div></section><section class="grid"><div class="card" id="botsCard"><div class="cardhead"><span>Accounts</span><span id="fleetSummary" style="color:var(--muted);font-weight:500"></span></div><div class="scroll"><table><thead><tr><th>Name</th><th>Status</th><th>Proxy</th><th>Ping</th><th>World changes</th><th>Last error</th></tr></thead><tbody id="bots"></tbody></table></div></div><div class="card" id="logsCard"><div class="cardhead"><span>Live activity</span><span id="uptime" style="color:var(--muted);font-weight:500">0 sec</span></div><div class="scroll" id="logs"></div><div class="composer"><input id="message" maxlength="256" placeholder="Message or /command from all active bots"><button class="btn primary" id="send">Send</button></div></div></section></main></div><script>const BOOT=${boot};const $=id=>document.getElementById(id);const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));async function api(path,body){const options={cache:'no-store'};if(body!==undefined){options.method='POST';options.headers={'content-type':'application/json','x-csrf-token':BOOT.csrf};options.body=JSON.stringify(body)}const r=await fetch('/api/'+path,options);if(r.status===401){location.href='/login';throw new Error('Session expired')}const j=await r.json();if(!r.ok)throw new Error(j.error||'Operation failed');return j}async function action(fn){try{$('notice').textContent='Working…';const result=await fn();$('notice').textContent=result.message||'Done';await refresh()}catch(error){$('notice').textContent=error.message}}const count=(s,n)=>s.counts[n]||0;const duration=ms=>{const sec=Math.floor((ms||0)/1000);if(sec<60)return sec+' sec';const min=Math.floor(sec/60);if(min<60)return min+' min';return Math.floor(min/60)+' hr '+min%60+' min'};async function refresh(){try{const s=await api('status');$('active').textContent=count(s,'aktif');$('connecting').textContent=count(s,'baglaniyor');$('failed').textContent=count(s,'hata')+count(s,'atildi')+count(s,'koptu');$('total').textContent=s.total;$('proxy').textContent=s.proxyCount;$('memory').textContent=s.memoryMb;$('target').textContent=s.server.host+':'+s.server.port+' · Minecraft '+s.server.version;$('uptime').textContent=duration(s.stats.uptimeMs);$('fleetSummary').textContent=count(s,'aktif')+' online · '+s.total+' total';const labels={aktif:'Online',baglaniyor:'Connecting',hata:'Error',atildi:'Kicked',koptu:'Disconnected',bekliyor:'Waiting',durduruldu:'Stopped'};$('bots').innerHTML=s.bots.map(b=>'<tr><td>'+esc(b.username)+'</td><td><span class="badge '+esc(b.state)+'">'+esc(labels[b.state]||b.state)+'</span></td><td>'+esc(b.proxy)+'</td><td>'+esc(b.ping??'—')+'</td><td>'+esc(b.worldChanges)+'</td><td class="errorText" title="'+esc(b.lastError)+'">'+esc(b.lastError)+'</td></tr>').join('');$('logs').innerHTML=s.logs.map(l=>'<div class="log"><span class="time">'+new Date(l.time).toLocaleTimeString('en-GB')+'</span> <span class="who">'+esc(l.username||'system')+'</span> <span class="'+(l.level==='error'?'errorText':'')+'">'+esc(l.message)+'</span></div>').join('')||'<div class="log">No activity yet.</div>'}catch(error){$('notice').textContent='Panel connection lost: '+error.message}}$('start').onclick=()=>action(()=>{const amount=Number($('amount').value);if(!Number.isInteger(amount)||amount<1||amount>BOOT.maxBots)throw new Error('Choose 1-'+BOOT.maxBots+' bots');return api('start',{limit:amount})});$('startAll').onclick=()=>action(()=>api('start',{}));$('retry').onclick=()=>action(()=>api('retry',{}));$('stop').onclick=()=>action(()=>api('stop',{}));$('send').onclick=()=>action(async()=>{const message=$('message').value.trim();if(!message)throw new Error('Enter a message or command');const result=await api('send',{message});$('message').value='';return result});$('message').onkeydown=e=>{if(e.key==='Enter')$('send').click()};$('navBots').onclick=()=>$('botsCard').scrollIntoView({behavior:'smooth'});$('navLogs').onclick=()=>$('logsCard').scrollIntoView({behavior:'smooth'});refresh();setInterval(refresh,2000)</script>`, 'AFK Control · 52hertz AFK')
}

function parseCookies (req) {
  return Object.fromEntries(String(req.headers.cookie || '').split(';').map(item => item.trim().split('=')).filter(pair => pair.length === 2))
}

function getSession (req) {
  const token = parseCookies(req)[SESSION_COOKIE]
  const session = token && sessions.get(token)
  if (!session || session.idleExpiresAt <= Date.now() || session.absoluteExpiresAt <= Date.now()) {
    if (token) sessions.delete(token)
    return null
  }
  session.idleExpiresAt = Math.min(Date.now() + SESSION_IDLE_TTL_MS, session.absoluteExpiresAt)
  return session
}

function getPendingSession (req) {
  const token = parseCookies(req)[PENDING_COOKIE]
  const pending = token && pendingSessions.get(token)
  if (!pending || pending.expiresAt <= Date.now() || !safeEqual(pending.ip, clientIp(req))) {
    if (token) pendingSessions.delete(token)
    return null
  }
  return { token, pending }
}

function safeEqual (a, b) {
  const left = crypto.createHash('sha256').update(String(a)).digest()
  const right = crypto.createHash('sha256').update(String(b)).digest()
  return crypto.timingSafeEqual(left, right)
}

function verifyPassword (password, encoded) {
  const [saltHex, hashHex] = String(encoded || '').split(':')
  if (!/^[0-9a-f]{32}$/i.test(saltHex || '') || !/^[0-9a-f]{64}$/i.test(hashHex || '')) return false
  const expected = Buffer.from(hashHex, 'hex')
  const actual = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), expected.length)
  return crypto.timingSafeEqual(actual, expected)
}

function decodeBase32 (encoded) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  const clean = String(encoded || '').toUpperCase().replace(/[\s=-]/g, '')
  if (!clean || /[^A-Z2-7]/.test(clean)) throw new Error('AFK_TOTP_SECRET must be a valid Base32 value')
  let bits = 0
  let value = 0
  const bytes = []
  for (const character of clean) {
    value = (value << 5) | alphabet.indexOf(character)
    bits += 5
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Buffer.from(bytes)
}

function totpCode (secret, timestamp = Date.now(), digits = 6) {
  const counter = Math.floor(Number(timestamp) / 30_000)
  const message = Buffer.alloc(8)
  message.writeBigUInt64BE(BigInt(counter))
  const digest = crypto.createHmac('sha1', decodeBase32(secret)).update(message).digest()
  const offset = digest[digest.length - 1] & 0x0f
  const binary = ((digest[offset] & 0x7f) << 24) | ((digest[offset + 1] & 0xff) << 16) | ((digest[offset + 2] & 0xff) << 8) | (digest[offset + 3] & 0xff)
  return String(binary % (10 ** digits)).padStart(digits, '0')
}

function verifyTotp (secret, candidate, timestamp = Date.now(), window = 1) {
  const code = String(candidate || '').trim()
  if (!/^\d{6}$/.test(code)) return null
  const currentCounter = Math.floor(Number(timestamp) / 30_000)
  for (let offset = -window; offset <= window; offset += 1) {
    const counter = currentCounter + offset
    if (counter < 0) continue
    if (safeEqual(code, totpCode(secret, counter * 30_000))) return counter
  }
  return null
}

function clientIp (req) {
  const remote = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '')
  const proxyIsLocal = remote === '::1' || net.isIPv4(remote) && remote.startsWith('127.')
  const realIp = String(req.headers['x-real-ip'] || '').trim()
  return proxyIsLocal && net.isIP(realIp) ? realIp : (remote || 'unknown')
}

function loginAllowed (ip) {
  const now = Date.now()
  const allowed = (key, limit) => {
    const entry = attempts.get(key)
    if (!entry || entry.resetAt <= now) {
      attempts.set(key, { count: 0, resetAt: now + 15 * 60 * 1000 })
      return true
    }
    return entry.count < limit
  }
  return allowed(`ip:${ip}`, IP_FAILURE_LIMIT) && allowed('global', GLOBAL_FAILURE_LIMIT)
}

function recordFailure (ip) {
  for (const key of [`ip:${ip}`, 'global']) {
    const entry = attempts.get(key) || { count: 0, resetAt: Date.now() + 15 * 60 * 1000 }
    entry.count += 1
    attempts.set(key, entry)
  }
}

function clearIpFailures (ip) {
  attempts.delete(`ip:${ip}`)
}

function hasContentType (req, expected) {
  return String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase() === expected
}

function readBody (req, maxBytes = 12_000) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let rejected = false
    req.on('data', chunk => {
      if (rejected) return
      size += chunk.length
      if (size > maxBytes) {
        rejected = true
        reject(new Error('Request is too large'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (!rejected) resolve(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', reject)
  })
}

function sendHtml (res, status, html, extra = {}, scriptNonce = '') {
  res.writeHead(status, { ...securityHeaders('text/html; charset=utf-8', scriptNonce), ...extra })
  res.end(html)
}

function sendJson (res, status, value) {
  res.writeHead(status, securityHeaders('application/json; charset=utf-8'))
  res.end(JSON.stringify(value))
}

function sendConfigDownload (res, config) {
  res.writeHead(200, {
    ...securityHeaders('application/json; charset=utf-8'),
    'content-disposition': 'attachment; filename="minecraft-afk-config.json"'
  })
  res.end(JSON.stringify(config, null, 2) + '\n')
}

function redirect (res, location, cookie) {
  res.writeHead(303, { location, 'cache-control': 'no-store', ...(cookie ? { 'set-cookie': cookie } : {}) })
  res.end()
}

function persistConfig (config, baseDir) {
  const target = path.resolve(baseDir, 'config.json')
  const temporary = `${target}.tmp-${process.pid}`
  fs.writeFileSync(temporary, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 })
  fs.renameSync(temporary, target)
}

function createDashboard (config, manager, options = {}) {
  const adminUser = process.env.AFK_ADMIN_USER
  const passwordHash = process.env.AFK_ADMIN_PASSWORD_SCRYPT
  const totpSecret = process.env.AFK_TOTP_SECRET
  const dataDir = path.resolve(options.dataDir || process.cwd())
  const totpStateFile = path.resolve(options.totpStateFile || path.join(dataDir, '.totp-enabled'))
  const reloadAfterImport = options.reloadAfterImport || (() => setTimeout(() => process.exit(75), 500).unref())
  if (!adminUser || !passwordHash) throw new Error('AFK_ADMIN_USER and AFK_ADMIN_PASSWORD_SCRYPT are required')
  if (!totpSecret) throw new Error('AFK_TOTP_SECRET is required')
  decodeBase32(totpSecret)
  const totpEnabled = () => fs.existsSync(totpStateFile)
  const readTotpCounter = () => {
    try {
      const state = JSON.parse(fs.readFileSync(totpStateFile, 'utf8'))
      return Number.isInteger(state.lastCounter) ? state.lastCounter : -1
    } catch { return -1 }
  }
  let lastTotpCounter = readTotpCounter()
  const saveTotpState = counter => {
    const temporary = `${totpStateFile}.tmp-${process.pid}`
    fs.writeFileSync(temporary, JSON.stringify({ enabledAt: new Date().toISOString(), lastCounter: counter }) + '\n', { mode: 0o600 })
    fs.renameSync(temporary, totpStateFile)
  }

  const cleanup = setInterval(() => {
    const now = Date.now()
    for (const [token, session] of sessions) if (session.idleExpiresAt <= now || session.absoluteExpiresAt <= now) sessions.delete(token)
    for (const [token, pending] of pendingSessions) if (pending.expiresAt <= now) pendingSessions.delete(token)
    for (const [ip, entry] of attempts) if (entry.resetAt <= now) attempts.delete(ip)
  }, 10 * 60 * 1000)
  cleanup.unref()

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost')
      if (req.method === 'GET' && url.pathname === '/health') return sendJson(res, 200, { ok: true })
      if (req.method === 'GET' && url.pathname === '/login') return sendHtml(res, 200, loginPage(url.searchParams.get('failed') === '1'))
      if (req.method === 'POST' && url.pathname === '/login') {
        if (!hasContentType(req, 'application/x-www-form-urlencoded')) return sendHtml(res, 415, 'Unsupported media type')
        const ip = clientIp(req)
        if (!loginAllowed(ip)) return sendHtml(res, 429, loginPage(true), { 'retry-after': '900' })
        const body = querystring.parse(await readBody(req))
        const usernameValid = safeEqual(body.username, adminUser)
        const passwordValid = verifyPassword(body.password, passwordHash)
        if (!usernameValid || !passwordValid) {
          recordFailure(ip)
          return redirect(res, '/login?failed=1')
        }
        for (const [token, pending] of pendingSessions) {
          if (safeEqual(pending.ip, ip)) pendingSessions.delete(token)
        }
        if (pendingSessions.size >= 64) {
          const oldest = pendingSessions.keys().next().value
          if (oldest) pendingSessions.delete(oldest)
        }
        const pendingToken = crypto.randomBytes(32).toString('hex')
        pendingSessions.set(pendingToken, { expiresAt: Date.now() + PENDING_TTL_MS, ip })
        return redirect(res, '/two-factor', `${PENDING_COOKIE}=${pendingToken}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${PENDING_TTL_MS / 1000}`)
      }
      if (req.method === 'GET' && url.pathname === '/two-factor') {
        const entry = getPendingSession(req)
        if (!entry) return redirect(res, '/login')
        const setup = !totpEnabled()
        const uri = `otpauth://totp/${encodeURIComponent(`AFK Control:${adminUser}`)}?secret=${encodeURIComponent(totpSecret)}&issuer=${encodeURIComponent('AFK Control')}&algorithm=SHA1&digits=6&period=30`
        const qrSvg = setup ? await QRCode.toString(uri, { type: 'svg', width: 210, margin: 1, color: { dark: '#111111', light: '#ffffff' } }) : ''
        return sendHtml(res, 200, twoFactorPage({ failed: url.searchParams.get('failed') === '1', setup, qrSvg, secret: setup ? totpSecret : '' }))
      }
      if (req.method === 'POST' && url.pathname === '/two-factor') {
        const entry = getPendingSession(req)
        if (!entry) return redirect(res, '/login')
        if (!hasContentType(req, 'application/x-www-form-urlencoded')) return sendHtml(res, 415, 'Unsupported media type')
        if (!loginAllowed(entry.pending.ip)) return sendHtml(res, 429, twoFactorPage({ failed: true }), { 'retry-after': '900' })
        const body = querystring.parse(await readBody(req))
        const counter = verifyTotp(totpSecret, body.code)
        if (counter == null || counter <= lastTotpCounter) {
          recordFailure(entry.pending.ip)
          return redirect(res, '/two-factor?failed=1')
        }
        lastTotpCounter = counter
        saveTotpState(counter)
        pendingSessions.delete(entry.token)
        clearIpFailures(entry.pending.ip)
        const token = crypto.randomBytes(32).toString('hex')
        const absoluteExpiresAt = Date.now() + SESSION_ABSOLUTE_TTL_MS
        sessions.set(token, { csrf: crypto.randomBytes(24).toString('hex'), idleExpiresAt: Date.now() + SESSION_IDLE_TTL_MS, absoluteExpiresAt })
        return redirect(res, '/', [
          `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_ABSOLUTE_TTL_MS / 1000}`,
          `${PENDING_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`
        ])
      }

      const session = getSession(req)
      if (!session) {
        if (url.pathname.startsWith('/api/')) return sendJson(res, 401, { error: 'Authentication required' })
        return redirect(res, '/login')
      }
      if (req.method === 'POST' && url.pathname === '/logout') {
        if (!hasContentType(req, 'application/x-www-form-urlencoded')) return sendHtml(res, 415, 'Unsupported media type')
        const body = querystring.parse(await readBody(req))
        if (!safeEqual(body.csrf, session.csrf)) return sendHtml(res, 403, 'Forbidden')
        const token = parseCookies(req)[SESSION_COOKIE]
        sessions.delete(token)
        return redirect(res, '/login', `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`)
      }
      if (req.method === 'GET' && url.pathname === '/') {
        const nonce = crypto.randomBytes(18).toString('base64url')
        return sendHtml(res, 200, webDashboardPage(session.csrf, config, nonce), {}, nonce)
      }
      if (req.method === 'GET' && url.pathname === '/api/status') return sendJson(res, 200, await manager.status({ compact: url.searchParams.get('compact') === '1', includeLogs: url.searchParams.get('logs') !== '0' }))
      if (req.method === 'GET' && url.pathname === '/api/status/delta') {
        const after = Number(url.searchParams.get('after') || 0)
        if (!Number.isSafeInteger(after) || after < 0) return sendJson(res, 400, { error: 'Invalid status revision' })
        return sendJson(res, 200, await manager.statusDelta(after))
      }
      if (req.method === 'GET' && url.pathname === '/api/activity') {
        const after = Number(url.searchParams.get('after') || 0)
        if (!Number.isSafeInteger(after) || after < 0) return sendJson(res, 400, { error: 'Invalid activity cursor' })
        return sendJson(res, 200, await manager.activitySince(after))
      }
      if (req.method === 'GET' && url.pathname === '/api/config/export') return sendConfigDownload(res, config)
      if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
        if (!safeEqual(req.headers['x-csrf-token'], session.csrf)) return sendJson(res, 403, { error: 'Invalid request token' })
        if (!hasContentType(req, 'application/json')) return sendJson(res, 415, { error: 'Content-Type must be application/json' })
        const largeRequest = ['/api/config/import', '/api/automation', '/api/plugins', '/api/settings'].includes(url.pathname)
        const raw = await readBody(req, url.pathname === '/api/config/import' ? 256_000 : largeRequest ? 64_000 : 12_000)
        const body = raw ? JSON.parse(raw) : {}
        if (url.pathname === '/api/start') {
          const limit = body.limit == null ? undefined : Number(body.limit)
          if (limit != null && (!Number.isInteger(limit) || limit < 1 || limit > config.fleet.accountCount)) throw new Error(`Bot count must be between 1 and ${config.fleet.accountCount}`)
          await manager.start(limit)
          return sendJson(res, 202, { message: limit ? `Starting ${limit} bots` : `Starting all ${config.fleet.accountCount} bots` })
        }
        if (url.pathname === '/api/start/additional') {
          const count = Number(body.count)
          const result = await manager.addBots(count)
          return sendJson(res, 202, { message: `Added ${result.added} bots; entry target is now ${result.target}`, ...result })
        }
        if (url.pathname === '/api/stop') {
          await manager.stop()
          return sendJson(res, 200, { message: 'All bots stopped' })
        }
        if (url.pathname === '/api/stop-count') {
          const count = Number(body.count)
          return sendJson(res, 200, { message: `${await manager.stopCount(count)} bots stopped; earliest connections were kept online` })
        }
        if (url.pathname === '/api/bot/retry') {
          const username = await manager.retryBot(body.username)
          return sendJson(res, 202, { message: `${username} queued for a single-account retry` })
        }
        if (url.pathname === '/api/entries/toggle') {
          const paused = await manager.toggleEntriesPaused()
          return sendJson(res, 200, { message: paused ? 'New entries paused; online bots remain connected' : 'Entry queue resumed', paused })
        }
        if (url.pathname === '/api/retry') return sendJson(res, 200, { message: `Retrying ${await manager.reconnectFailed()} bots` })
        if (url.pathname === '/api/send') {
          const message = String(body.message || '').trim()
          if (!message || message.length > 256) throw new Error('Message must contain 1-256 characters')
          const count = await manager.queueBroadcast(message, { type: 'all' })
          return sendJson(res, 202, { message: `Message queued for ${count} active accounts` })
        }
        if (url.pathname === '/api/automation') {
          const automation = normalizeAutomationSettings({
            initial: body.initial,
            onWorldChange: body.onWorldChange,
            scheduledMessage: body.scheduledMessage,
            conditionalRules: body.conditionalRules || []
          })
          config.commands = { initial: automation.initial, onWorldChange: automation.onWorldChange }
          config.scheduledMessage = automation.scheduledMessage
          config.conditionalRules = automation.conditionalRules
          persistConfig(config, dataDir)
          await manager.updateAutomation(config.commands, config.scheduledMessage, config.conditionalRules)
          return sendJson(res, 200, { message: 'Automation saved and applied immediately' })
        }
        if (url.pathname === '/api/optimizations') {
          config.optimizations = {
            deltaStatusUpdates: body.deltaStatusUpdates !== false,
            disableBotPhysics: body.disableBotPhysics !== false
          }
          const plugins = structuredClone(config.plugins)
          plugins['global-connection-queue'] ||= { enabled: true, settings: {} }
          plugins['global-connection-queue'].enabled = body.globalConnectionQueue !== false
          config.plugins = normalizePlugins(plugins)
          persistConfig(config, dataDir)
          await manager.updatePlugins(config.plugins)
          await manager.updateOptimizations(config.optimizations)
          return sendJson(res, 200, {
            message: 'Optimization settings saved and applied immediately',
            optimizations: {
              deltaStatusUpdates: config.optimizations.deltaStatusUpdates,
              disableBotPhysics: config.optimizations.disableBotPhysics,
              globalConnectionQueue: config.plugins['global-connection-queue'].enabled
            }
          })
        }
        if (url.pathname === '/api/bypass') {
          config.bypass = {
            resourcePackHandling: body.resourcePackHandling !== false,
            transferCompatibility: body.transferCompatibility !== false
          }
          persistConfig(config, dataDir)
          await manager.updateBypass(config.bypass)
          return sendJson(res, 200, {
            message: 'Bypass settings saved and applied immediately',
            bypass: config.bypass
          })
        }
        if (url.pathname === '/api/service/restart') {
          await manager.stop()
          sendJson(res, 202, { message: 'Service restart requested. All bot connections were stopped.', reloading: true })
          reloadAfterImport()
          return
        }
        if (url.pathname === '/api/plugins') {
          const submitted = body.plugins && typeof body.plugins === 'object' ? body.plugins : {}
          const merged = structuredClone(config.plugins)
          for (const [id, value] of Object.entries(submitted)) {
            if (!Object.hasOwn(merged, id)) continue
            const settings = value?.settings && typeof value.settings === 'object' && !Array.isArray(value.settings) ? value.settings : {}
            merged[id] = { ...merged[id], enabled: Boolean(value?.enabled), settings: { ...merged[id].settings, ...settings } }
          }
          const plugins = normalizePlugins(merged)
          if (!plugins['command-workflow'].enabled && (plugins['auto-authentication'].enabled || plugins['world-change-commands'].enabled)) {
            throw new Error('Command Workflow must be enabled while authentication or world-change commands are enabled')
          }
          config.plugins = plugins
          persistConfig(config, dataDir)
          await manager.updatePlugins(config.plugins)
          return sendJson(res, 200, { message: 'Plugin settings saved and applied immediately' })
        }
        if (url.pathname === '/api/settings') {
          if (manager.running) throw new Error('Stop all bots before changing server or connection settings')
          const next = structuredClone(config)
          next.server.host = String(body.server?.host || '').trim()
          next.server.port = Number(body.server?.port)
          next.server.version = String(body.server?.version || '').trim()
          next.server.auth = 'offline'
          next.fleet.accountCount = Number(body.fleet?.accountCount)
          next.fleet.staggerMs = Math.round(Number(body.fleet?.staggerMs))
          next.fleet.requireProxy = Boolean(body.fleet?.requireProxy)
          next.fleet.proxyTimeoutMs = Math.round(Number(body.fleet?.proxyTimeoutMs))
          next.fleet.autoReconnect = Boolean(body.fleet?.autoReconnect)
          next.fleet.reconnectBaseMs = Math.round(Number(body.fleet?.reconnectBaseMs))
          next.fleet.reconnectMaxMs = Math.round(Number(body.fleet?.reconnectMaxMs))
          const validated = validateConfig(next)
          const accounts = loadAccounts(dataDir)
          if (accounts.length < validated.fleet.accountCount) throw new Error(`Only ${accounts.length} accounts are installed`)
          const proxies = parseProxyText(fs.readFileSync(path.join(dataDir, 'proxies.txt'), 'utf8'))
          if (validated.fleet.requireProxy && proxies.length < validated.fleet.accountCount * 3) throw new Error(`Proxy-required mode needs ${validated.fleet.accountCount * 3} proxies; ${proxies.length} are installed`)
          persistConfig(validated, dataDir)
          sendJson(res, 200, { message: 'Server and connection settings saved. The service is reloading.', reloading: true })
          reloadAfterImport()
          return
        }
        if (url.pathname === '/api/config/import') {
          if (manager.running) throw new Error('Stop all bots before importing a configuration')
          if (!body.config || typeof body.config !== 'object' || Array.isArray(body.config)) throw new Error('The selected file does not contain a valid configuration object')
          const imported = validateConfig(structuredClone(body.config))
          const accounts = loadAccounts(dataDir)
          if (accounts.length < imported.fleet.accountCount) throw new Error(`Configuration requires ${imported.fleet.accountCount} accounts, but only ${accounts.length} are installed`)
          const proxies = parseProxyText(fs.readFileSync(path.join(dataDir, 'proxies.txt'), 'utf8'))
          if (imported.fleet.requireProxy && proxies.length < imported.fleet.accountCount * 3) throw new Error(`Configuration requires ${imported.fleet.accountCount * 3} proxies, but only ${proxies.length} are installed`)
          persistConfig(imported, dataDir)
          await manager.stop()
          sendJson(res, 200, { message: 'Configuration imported. The service is reloading now.', reloading: true })
          reloadAfterImport()
          return
        }
      }
      sendJson(res, 404, { error: 'Not found' })
    } catch (error) {
      sendJson(res, 400, { error: error.message })
    }
  })
  server.requestTimeout = 15_000
  server.headersTimeout = 10_000
  server.keepAliveTimeout = 5_000
  server.maxHeadersCount = 100
  server.on('clientError', (_, socket) => socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'))
  server.on('close', () => clearInterval(cleanup))
  return server
}

module.exports = { createDashboard, verifyPassword, totpCode, verifyTotp }
