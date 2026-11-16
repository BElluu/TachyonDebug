// TachyonDebug: a small local server that
//  - serves the web UI,
//  - keeps several Tachyon client connections open on behalf of the browser
//    (browsers cannot set the Authorization header on a WebSocket),
//  - exposes the protocol schemas as a command catalog,
//  - manages a local Teiserver checkout (start/stop), saved requests and scenarios.
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { WebSocket, WebSocketServer } from 'ws'
import { buildCatalog } from './catalog.js'
import { runScenario, listScenarios, subst } from './scenarios.js'
import { createLocalServer } from './localServer.js'
import { startLogin, refresh } from './oauth.js'
import { createSettings, checkTeiserver, checkTachyon, detect, expandHome } from './settings.js'
import { loadCollections, saveCollections } from './collections.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.PORT ?? 4747)
const DATA = process.env.TACHYON_DEBUG_DATA ?? path.join(ROOT, 'data')
fs.mkdirSync(DATA, { recursive: true })
const SESSIONS_FILE = path.join(DATA, 'sessions.json')
const BUILTIN_SCENARIOS = path.join(ROOT, 'scenarios')
const USER_SCENARIOS = path.join(DATA, 'scenarios')
fs.mkdirSync(USER_SCENARIOS, { recursive: true })
const allScenarios = () => [...listScenarios(BUILTIN_SCENARIOS, 'builtin'), ...listScenarios(USER_SCENARIOS, 'user')]
const slug = (name) => String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'scenario'

const settings = createSettings(DATA, ROOT)
let collections = loadCollections(DATA)

const uiClients = new Set()
function broadcast(payload) {
  const text = JSON.stringify(payload)
  for (const c of uiClients) if (c.readyState === WebSocket.OPEN) c.send(text)
}
const toast = (level, text) => broadcast({ op: 'toast', level, text })

// ---- settings-derived state ----------------------------------------------------

let ENVS, catalog, local
const localLogs = []

function buildEnvs(s) {
  return {
    local: {
      label: 'Local',
      url: s.localUrl,
      httpUrl: s.localUrl.replace(/^ws/, 'http').replace(/\/tachyon\/?$/, '/'),
      managed: true
    },
    dev: { label: 'Dev', url: s.devUrl.replace(/^http/, 'ws') + '/tachyon', base: s.devUrl, oauth: true }
  }
}

function applySettings() {
  const s = settings.get()
  ENVS = buildEnvs(s)
  catalog = buildCatalog(path.join(path.resolve(expandHome(s.tachyonDir)), 'schema'))
  const prev = local
  local = createLocalServer({
    dir: path.resolve(expandHome(s.teiserverDir)),
    httpUrl: ENVS.local.httpUrl,
    onChange: (st) => broadcast({ op: 'local', ...st }),
    onLog: (text) => {
      localLogs.push(text)
      if (localLogs.length > 500) localLogs.shift()
      broadcast({ op: 'localLog', text })
    }
  })
  // a server we spawned must stay controllable after a settings change
  if (prev?.child) Object.assign(local, { child: prev.child, managed: true, status: prev.status })
  local.refresh()
}

const currentChecks = () => {
  const s = settings.get()
  return { teiserver: checkTeiserver(s.teiserverDir), tachyon: checkTachyon(s.tachyonDir) }
}

// ---- dev server reachability ---------------------------------------------------

let devStatus = 'unknown' // unknown | reachable | unreachable
async function pingDev() {
  let next = 'unreachable'
  try {
    const res = await fetch(new URL('/.well-known/oauth-authorization-server', ENVS.dev.base), { signal: AbortSignal.timeout(5000) })
    if (res.ok) next = 'reachable'
  } catch {
    /* unreachable */
  }
  if (next !== devStatus) {
    devStatus = next
    broadcast({ op: 'devStatus', status: devStatus })
  }
}

// ---- client sessions -------------------------------------------------------------

/** @type {Map<string, {name:string,env:string,url:string,token:string,ws:WebSocket|null,state:string,user:any}>} */
const sessions = new Map()

function loadSavedSessions() {
  try {
    for (const s of JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'))) {
      sessions.set(s.name, { ...s, ws: null, state: 'closed', user: null })
    }
  } catch {
    /* first run */
  }
}
function persistSessions() {
  const out = [...sessions.values()].map(({ name, url, token, env, refreshToken, expiresAt, tokenUser, issuedAt }) => ({ name, url, token, env, refreshToken, expiresAt, tokenUser, issuedAt }))
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(out, null, 2))
}

// tokens never leave the helper process
const publicSession = (s) => ({ name: s.name, env: s.env, tokenUser: s.tokenUser, url: s.url, state: s.state, user: s.user, hasToken: !!s.token, expiresAt: s.expiresAt })
const emitSession = (s) => broadcast({ op: 'session', session: publicSession(s) })

const scenarioListeners = new Set()
function log(session, dir, msg, extra = {}) {
  const entry = { op: 'msg', ts: Date.now(), session, dir, msg, ...extra }
  broadcast(entry)
  scenarioListeners.forEach((fn) => fn(entry))
}
const sys = (session, text, error = false) => log(session, 'sys', { text, error })

const TOKEN_MAX_AGE_MS = 20 * 3600 * 1000

// Make sure the target is usable (local server up, OAuth token fresh). Throws a readable error.
async function prepare(s) {
  const e = ENVS[s.env]
  if (e?.managed && s.url === e.url && (await local.refresh()) !== 'up') {
    if (!settings.get().autostart) throw new Error('the local Teiserver is down (auto-start is off in Settings)')
    sys(s.name, 'local Teiserver is down, starting it… (can take a while, see the log at the bottom)')
    await local.ensureUp()
  }
  // local tokens come from `mix teiserver.gen_token`, last 24h and are bound to a real Teiserver user
  if (s.env === 'local' && s.tokenUser && (!s.token || Date.now() - (s.issuedAt ?? 0) > TOKEN_MAX_AGE_MS)) {
    sys(s.name, `generating a token for Teiserver user "${s.tokenUser}"…`)
    s.token = await genToken(s.tokenUser)
    s.issuedAt = Date.now()
    persistSessions()
  }
  if (e?.oauth && s.refreshToken && (!s.expiresAt || s.expiresAt - Date.now() < 60_000)) {
    sys(s.name, 'refreshing access token')
    const t = await refresh({ base: e.base, clientId: settings.get().clientId, refreshToken: s.refreshToken })
    Object.assign(s, { token: t.accessToken, refreshToken: t.refreshToken, expiresAt: t.expiresAt })
    persistSessions()
  }
}

async function connect({ name, url, token, env = 'local', refreshToken = null, expiresAt = null, tokenUser = null, issuedAt = null }) {
  if (!name) throw new Error('session needs a name')
  const prev = sessions.get(name)
  if (prev?.ws) prev.ws.close()
  const e = ENVS[env]
  const s = { name, env, url: url || e?.url, token: token ?? '', refreshToken, expiresAt, tokenUser, issuedAt, ws: null, state: 'connecting', user: null }
  sessions.set(name, s)
  persistSessions()
  emitSession(s)

  try {
    await prepare(s)
  } catch (err) {
    s.state = 'closed'
    sys(name, `cannot connect: ${err.message}`, true)
    emitSession(s)
    return s
  }
  openSocket(s)
  return s
}

function openSocket(s) {
  const name = s.name
  const ws = new WebSocket(s.url, ['v0.tachyon'], { headers: { Authorization: `Bearer ${s.token}` } })
  s.ws = ws
  ws.on('open', () => {
    s.regenTried = false
    s.state = 'open'
    sys(name, `connected to ${s.url}`)
    emitSession(s)
  })
  ws.on('message', (data) => {
    let msg
    try { msg = JSON.parse(data.toString()) } catch { msg = { unparsable: data.toString() } }
    if (msg.commandId === 'user/self' && msg.data?.user) {
      const u = msg.data.user
      s.user = { id: u.userId ?? u.id ?? null, name: u.username ?? u.name ?? null }
      emitSession(s)
    }
    log(name, 'in', msg)
  })
  ws.on('unexpected-response', async (_req, res) => {
    // an expired local token is routine: make a fresh one once and retry
    if (res.statusCode === 401 && s.tokenUser && !s.regenTried && s.ws === ws) {
      s.regenTried = true
      sys(name, 'token rejected, generating a fresh one…')
      try {
        s.token = await genToken(s.tokenUser)
        s.issuedAt = Date.now()
        persistSessions()
        return openSocket(s)
      } catch (err) {
        sys(name, `could not renew the token: ${err.message}`, true)
      }
    }
    const hint = res.statusCode === 401 ? 'token rejected: expired, or issued by another server' : 'is the server up?'
    sys(name, `HTTP ${res.statusCode} ${res.statusMessage} (${hint})`, true)
    s.state = 'closed'
    emitSession(s)
  })
  ws.on('close', (code, reason) => {
    if (s.ws !== ws) return
    s.state = 'closed'
    sys(name, `closed (${code}) ${reason.toString()}`)
    emitSession(s)
  })
  ws.on('error', (err) => sys(name, `error: ${err.message}`, true))
}

function disconnect(name) {
  sessions.get(name)?.ws?.close(1000, 'bye')
}
function removeSession(name) {
  disconnect(name)
  sessions.delete(name)
  persistSessions()
  broadcast({ op: 'sessionRemoved', name })
}

export function send(name, { commandId, data, type = 'request', messageId }) {
  const s = sessions.get(name)
  if (!s?.ws || s.ws.readyState !== WebSocket.OPEN) throw new Error(`session "${name}" is not connected`)
  const msg = { type, messageId: messageId ?? randomUUID(), commandId }
  if (data !== undefined) msg.data = data
  s.ws.send(JSON.stringify(msg))
  log(name, 'out', msg)
  return msg.messageId
}

// ---- creating sessions the easy way ----------------------------------------------

function runMix(args, dir) {
  return new Promise((resolve, reject) => {
    // `mise exec` gives mix the project's tool versions and env (PGPASSWORD...); fall back to plain mix
    const attempt = (cmd, cmdArgs, fallback) => {
      const p = spawn(cmd, cmdArgs, { cwd: dir, env: process.env })
      let out = ''
      p.stdout.on('data', (d) => (out += d))
      p.stderr.on('data', (d) => (out += d))
      p.on('error', (err) => (fallback ? fallback() : reject(new Error(`cannot run ${cmd}: ${err.message}`))))
      p.on('close', () => resolve(out))
    }
    attempt('mise', ['exec', '--', 'mix', ...args], () => attempt('mix', args))
  })
}

// Pull a readable message out of mix output (drop ANSI colours, debug/SQL noise and the usage hint).
function mixError(out) {
  const lines = out
    .replace(/\x1b\[[0-9;]*m/g, '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^\d\d:\d\d:\d\d\.\d+ \[/.test(l) && !/^(raw|parsed) args|^(SELECT|INSERT|UPDATE|DELETE|commit|begin)\b|^\[\]$/i.test(l))
  return (lines.at(-1) ?? 'no token produced').replace(/\s+--\s+Usage:.*$/, '')
}

async function genToken(user) {
  const dir = path.resolve(expandHome(settings.get().teiserverDir))
  const out = await runMix(['teiserver.gen_token', '--user', user, '--app', 'generic_lobby'], dir)
  const m = out.match(/Generated token \(id=\d+\) - (\S+)/)
  if (m) return m[1]
  throw new Error(mixError(out))
}

// Existing (non-bot) users of the local Teiserver, read straight from its dev database.
function dbSettings(dir) {
  let text = ''
  try { text = fs.readFileSync(path.join(dir, 'config', 'dev.exs'), 'utf8') } catch { /* defaults below */ }
  const pick = (key, d) => text.match(new RegExp(`${key}:\\s*"([^"]+)"`))?.[1] ?? d
  return { user: pick('username', 'teiserver_dev'), password: pick('password', ''), db: pick('database', 'teiserver_dev'), host: pick('hostname', 'localhost') }
}

function runTool(cmd, args, dir, env = {}) {
  return new Promise((resolve, reject) => {
    const attempt = (c, a, fallback) => {
      const p = spawn(c, a, { cwd: dir, env: { ...process.env, ...env } })
      let out = ''
      let err = ''
      p.stdout.on('data', (d) => (out += d))
      p.stderr.on('data', (d) => (err += d))
      p.on('error', (e) => (fallback ? fallback() : reject(new Error(`cannot run ${c}: ${e.message}`))))
      p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(err.trim().split('\n').at(-1) || `${c} exited with ${code}`))))
    }
    attempt('mise', ['exec', '--', cmd, ...args], () => attempt(cmd, args))
  })
}

async function listLocalUsers() {
  const dir = path.resolve(expandHome(settings.get().teiserverDir))
  const { user, password, db, host } = dbSettings(dir)
  const query = () => runTool('psql', ['-h', host, '-U', user, '-d', db, '-At', '-F', '\t', '-c', 'select id, name from account_users where bot = false order by id limit 300'], dir, { PGPASSWORD: password })
  let out
  try {
    out = await query()
  } catch (err) {
    if (!/refused|could not connect|Connection/i.test(err.message)) throw err
    sys('helper', 'Postgres is not running, starting it to read the user list…')
    await local.ensurePostgres()
    out = await query()
  }
  return out.split('\n').filter(Boolean).map((l) => { const [id, name] = l.split('\t'); return { id, name } })
}

// One click: server up -> token -> connected. Sequential so several players do not fight over mix/DB.
// `players` are { user, alias }: the real Teiserver username and the name of the session.
let localQueue = Promise.resolve()
function addLocalSessions(players) {
  for (const { user, alias } of players) {
    const name = alias || user
    if (['open', 'connecting'].includes(sessions.get(name)?.state)) continue
    const s = { name, env: 'local', url: ENVS.local.url, token: '', tokenUser: user, issuedAt: 0, ws: null, state: 'connecting', user: null }
    sessions.set(name, s)
    emitSession(s)
    localQueue = localQueue.then(async () => {
      try {
        await prepare(s) // starts the server if needed and generates the token
        await connect({ name, env: 'local', token: s.token, tokenUser: user, issuedAt: s.issuedAt })
      } catch (err) {
        // do not leave a dead player behind: it would only fail again with an empty token
        sessions.delete(name)
        persistSessions()
        broadcast({ op: 'sessionRemoved', name })
        toast('error', `Could not add “${user}”: ${err.message}`)
      }
    })
  }
}

async function loginDev(name) {
  const s = { name, env: 'dev', url: ENVS.dev.url, token: '', ws: null, state: 'connecting', user: null }
  sessions.set(name, s)
  emitSession(s)
  const fail = (err) => {
    s.state = 'closed'
    sys(name, `login failed: ${err.message}`, true)
    emitSession(s)
  }
  try {
    const { authUrl, result } = await startLogin({ base: ENVS.dev.base, clientId: settings.get().clientId })
    sys(name, 'waiting for the login in your browser…')
    broadcast({ op: 'openUrl', url: authUrl })
    result
      .then((t) => connect({ name, env: 'dev', token: t.accessToken, refreshToken: t.refreshToken, expiresAt: t.expiresAt }))
      .catch(fail)
  } catch (err) {
    fail(err)
  }
}

// ---- HTTP + UI websocket ---------------------------------------------------------

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }
const PUBLIC = path.join(ROOT, 'public')
const server = http.createServer((req, res) => {
  const urlPath = req.url === '/' ? '/index.html' : decodeURIComponent(req.url.split('?')[0])
  const file = path.join(PUBLIC, path.normalize(urlPath))
  if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404).end('not found')
    return
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' })
  fs.createReadStream(file).pipe(res)
})

const wss = new WebSocketServer({ server, path: '/ui' })

const initPayload = () => ({
  op: 'init',
  settings: settings.get(),
  checks: currentChecks(),
  envs: ENVS,
  catalog,
  collections,
  sessions: [...sessions.values()].map(publicSession),
  local: { status: local.status, managed: local.managed, logs: localLogs },
  devStatus,
  scenarios: allScenarios()
})

wss.on('connection', (ui) => {
  uiClients.add(ui)
  ui.on('close', () => uiClients.delete(ui))
  ui.send(JSON.stringify(initPayload()))

  ui.on('message', async (raw) => {
    let m
    try { m = JSON.parse(raw.toString()) } catch { return }
    const reply = (payload) => ui.send(JSON.stringify({ reqId: m.reqId, ...payload }))
    try {
      switch (m.op) {
        case 'connect': {
          // reconnecting reuses what we stored (the UI never sees tokens)
          const prev = sessions.get(m.name)
          if (!prev) throw new Error(`unknown session ${m.name}`)
          if (prev.state === 'connecting') break
          connect({ name: prev.name, env: prev.env, url: prev.url, token: prev.token, refreshToken: prev.refreshToken, expiresAt: prev.expiresAt, tokenUser: prev.tokenUser, issuedAt: prev.issuedAt })
            .catch((err) => toast('error', err.message))
          break
        }
        case 'connectManual': // name + pasted token
          connect({ name: m.name, env: m.env, url: m.url, token: m.token }).catch((err) => toast('error', err.message))
          break
        case 'disconnect': disconnect(m.name); break
        case 'removeSession': removeSession(m.name); break
        case 'addLocalSessions': addLocalSessions(m.players); break
        case 'localUsers': reply({ op: 'localUsers', users: await listLocalUsers() }); break
        case 'loginDev': await loginDev(m.name); break
        case 'send':
          // `${bob.id}` style placeholders are resolved from the connected sessions
          send(m.name, { commandId: m.commandId, messageId: m.messageId, data: m.data === undefined ? undefined : subst(m.data, sessions) })
          break

        case 'collectionsSet':
          collections = m.collections
          saveCollections(DATA, collections)
          for (const c of uiClients) if (c !== ui && c.readyState === WebSocket.OPEN) c.send(JSON.stringify({ op: 'collections', collections }))
          break

        case 'settingsCheck': {
          const checks = { teiserver: checkTeiserver(m.teiserverDir), tachyon: checkTachyon(m.tachyonDir) }
          const commands = checks.tachyon.ok ? buildCatalog(path.join(path.resolve(expandHome(m.tachyonDir)), 'schema')).commands.length : null
          reply({ op: 'settingsChecked', checks, commands })
          break
        }
        case 'detectPaths': reply({ op: 'detected', found: detect(ROOT) }); break
        case 'settingsSave': {
          const { setupDone, teiserverDir, tachyonDir, localUrl, devUrl, clientId, autostart } = m.settings
          settings.save({ setupDone, teiserverDir, tachyonDir, localUrl, devUrl, clientId, autostart })
          applySettings()
          pingDev()
          const p = JSON.stringify(initPayload())
          for (const c of uiClients) if (c.readyState === WebSocket.OPEN) c.send(p)
          break
        }

        case 'localStart':
          local.ensureUp().catch((err) => broadcast({ op: 'localLog', text: `start failed: ${err.message}\n` }))
          break
        case 'localStop':
          await local.stop({ force: !!m.force }).catch((err) => toast('error', err.message))
          break

        case 'runScenario': {
          const sc = allScenarios().find((x) => x.id === m.id)
          if (!sc) throw new Error('unknown scenario')
          runScenario(sc, {
            sessions, send, connect,
            onLog: (e) => broadcast({ op: 'scenarioLog', ...e }),
            listen: (fn) => (scenarioListeners.add(fn), () => scenarioListeners.delete(fn))
          })
          break
        }
        case 'scenarioSave': {
          const sc = m.scenario
          if (!sc?.name || !Array.isArray(sc.steps)) throw new Error('a scenario needs a name and a list of steps')
          const clean = { name: String(sc.name), category: sc.category || 'Custom', description: sc.description ?? '', sessions: sc.sessions ?? [], steps: sc.steps }
          // editing a custom scenario overwrites its file; anything else (new, imported, builtin copy) gets a fresh one
          let file = m.id?.startsWith('user:') ? m.id.slice(5) : null
          if (!file) {
            const base = slug(clean.name)
            file = `${base}.json`
            for (let n = 2; fs.existsSync(path.join(USER_SCENARIOS, file)); n++) file = `${base}-${n}.json`
          }
          fs.writeFileSync(path.join(USER_SCENARIOS, file), JSON.stringify(clean, null, 2))
          broadcast({ op: 'scenarios', list: allScenarios(), saved: `user:${file}` })
          break
        }
        case 'scenarioDelete': {
          if (!m.id?.startsWith('user:')) throw new Error('only your own scenarios can be deleted')
          fs.rmSync(path.join(USER_SCENARIOS, path.basename(m.id.slice(5))), { force: true })
          broadcast({ op: 'scenarios', list: allScenarios() })
          break
        }
      }
    } catch (err) {
      reply({ op: 'error', message: err.message })
      toast('error', err.message)
    }
  })
})

applySettings()
loadSavedSessions()
pingDev()
setInterval(() => local.refresh(), 5000).unref()
setInterval(pingDev, 30_000).unref()
server.listen(PORT, '127.0.0.1', () => {
  console.log(`TachyonDebug on http://localhost:${PORT}`)
  console.log(`  schemas: ${catalog.commands.length} commands${catalog.error ? ' WARNING: ' + catalog.error : ''}`)
  if (!settings.get().setupDone) console.log('  first run: the setup wizard opens in the browser')
})
