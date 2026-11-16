// TachyonDebug: a tiny local server that
//  - serves the web UI,
//  - keeps several Tachyon client connections open on behalf of the browser
//    (browsers cannot set the Authorization header on a WebSocket),
//  - exposes the protocol schemas as a command catalog,
//  - runs scenarios (scripted multi-client flows).
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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CONFIG = {
  port: Number(process.env.PORT ?? 4747),
  tachyonDir: path.resolve(process.env.TACHYON_DIR ?? path.join(ROOT, '..', 'tachyon')),
  teiserverDir: path.resolve(process.env.TEISERVER_DIR ?? path.join(ROOT, '..', 'teiserver')),
  defaultUrl: process.env.TACHYON_URL ?? 'ws://localhost:4000/tachyon',
  devBase: process.env.TACHYON_DEV_URL ?? 'https://lobby-server-dev.beyondallreason.dev',
  clientId: process.env.TACHYON_CLIENT_ID ?? 'generic_lobby',
  dataDir: path.join(ROOT, 'data')
}
fs.mkdirSync(CONFIG.dataDir, { recursive: true })
const SESSIONS_FILE = path.join(CONFIG.dataDir, 'sessions.json')
const TOOLBOX_FILE = path.join(CONFIG.dataDir, 'toolbox.json')

// Toolbox: saved requests ({ id, name, as, commandId, data }) that can be fired in one click.
let toolbox = []
try {
  toolbox = JSON.parse(fs.readFileSync(TOOLBOX_FILE, 'utf8'))
} catch {
  /* first run */
}
const saveToolbox = () => {
  fs.writeFileSync(TOOLBOX_FILE, JSON.stringify(toolbox, null, 2))
  broadcast({ op: 'toolbox', items: toolbox })
}

// Environments a session can target. `local` is a Teiserver checkout we can start
// ourselves; `dev` is the shared dev server, where tokens come from the OAuth login.
const ENVS = {
  local: { label: 'local', url: CONFIG.defaultUrl, httpUrl: CONFIG.defaultUrl.replace(/^ws/, 'http').replace(/\/tachyon$/, '/'), managed: true },
  dev: { label: 'dev', url: CONFIG.devBase.replace(/^http/, 'ws') + '/tachyon', base: CONFIG.devBase, oauth: true }
}

const localLogs = []
const local = createLocalServer({
  dir: CONFIG.teiserverDir,
  httpUrl: ENVS.local.httpUrl,
  onChange: (st) => broadcast({ op: 'local', ...st }),
  onLog: (text) => {
    localLogs.push(text)
    if (localLogs.length > 500) localLogs.shift()
    broadcast({ op: 'localLog', text })
  }
})

const catalog = buildCatalog(path.join(CONFIG.tachyonDir, 'schema'))

// ---- client sessions -------------------------------------------------------

/** @type {Map<string, {name:string,url:string,token:string,ws:WebSocket|null,state:string,user:any}>} */
const sessions = new Map()
const uiClients = new Set()

function loadSavedSessions() {
  try {
    for (const s of JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'))) {
      sessions.set(s.name, { ...s, ws: null, state: 'closed', user: null })
    }
  } catch {
    /* first run */
  }
}

function saveSessions() {
  const out = [...sessions.values()].map(({ name, url, token, env, refreshToken, expiresAt }) => ({ name, url, token, env, refreshToken, expiresAt }))
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(out, null, 2))
}

function broadcast(payload) {
  const text = JSON.stringify(payload)
  for (const c of uiClients) if (c.readyState === WebSocket.OPEN) c.send(text)
}

const publicSession = (s) => ({
  name: s.name,
  env: s.env,
  refreshToken: s.refreshToken,
  expiresAt: s.expiresAt,
  url: s.url,
  token: s.token,
  state: s.state,
  user: s.user
})

function emitSession(s) {
  broadcast({ op: 'session', session: publicSession(s) })
}

function log(session, dir, msg, extra = {}) {
  const entry = { op: 'msg', ts: Date.now(), session, dir, msg, ...extra }
  broadcast(entry)
  scenarioListeners.forEach((fn) => fn(entry))
}

const scenarioListeners = new Set()

// Prepare the target (start local server / refresh an expiring OAuth token), then open the socket.
async function connect({ name, url, token, env = 'local', refreshToken = null, expiresAt = null }) {
  if (!name) throw new Error('session needs a name')
  const prev = sessions.get(name)
  if (prev?.ws) prev.ws.close()
  const e = ENVS[env]
  const s = { name, env, url: url || e?.url || CONFIG.defaultUrl, token: token ?? '', refreshToken, expiresAt, ws: null, state: 'connecting', user: null }
  sessions.set(name, s)
  saveSessions()
  emitSession(s)

  try {
    if (e?.managed && s.url === e.url) {
      if (!(await local.refresh().then((st) => st === 'up'))) {
        log(name, 'sys', { text: 'local server is down, starting it (this can take a while)…' })
        await local.ensureUp()
      }
    }
    if (e?.oauth && s.refreshToken && (!s.expiresAt || s.expiresAt - Date.now() < 60_000)) {
      log(name, 'sys', { text: 'refreshing access token' })
      const t = await refresh({ base: e.base, clientId: CONFIG.clientId, refreshToken: s.refreshToken })
      Object.assign(s, { token: t.accessToken, refreshToken: t.refreshToken, expiresAt: t.expiresAt })
      saveSessions()
    }
  } catch (err) {
    s.state = 'closed'
    log(name, 'sys', { text: `cannot connect: ${err.message}`, error: true })
    emitSession(s)
    return s
  }

  const ws = new WebSocket(s.url, ['v0.tachyon'], {
    headers: { Authorization: `Bearer ${s.token}` }
  })
  s.ws = ws

  ws.on('open', () => {
    s.state = 'open'
    log(name, 'sys', { text: `connected to ${s.url}` })
    emitSession(s)
  })
  ws.on('message', (data) => {
    const text = data.toString()
    let msg
    try {
      msg = JSON.parse(text)
    } catch {
      msg = { unparsable: text }
    }
    if (msg.commandId === 'user/self' && msg.data?.user) {
      const u = msg.data.user
      s.user = { id: u.userId ?? u.id ?? null, name: u.username ?? u.name ?? null }
      emitSession(s)
    }
    log(name, 'in', msg)
  })
  ws.on('unexpected-response', (_req, res) => {
    log(name, 'sys', { text: `HTTP ${res.statusCode} ${res.statusMessage} (bad token? server down?)`, error: true })
    s.state = 'closed'
    emitSession(s)
  })
  ws.on('close', (code, reason) => {
    if (s.ws !== ws) return
    s.state = 'closed'
    log(name, 'sys', { text: `closed (${code}) ${reason.toString()}` })
    emitSession(s)
  })
  ws.on('error', (err) => {
    log(name, 'sys', { text: `error: ${err.message}`, error: true })
  })
  return s
}

function disconnect(name) {
  const s = sessions.get(name)
  if (s?.ws) s.ws.close(1000, 'bye')
}

function removeSession(name) {
  disconnect(name)
  sessions.delete(name)
  saveSessions()
  broadcast({ op: 'sessionRemoved', name })
}

// Send a message on behalf of a session. Returns the messageId used.
export function send(name, { commandId, data, type = 'request', messageId }) {
  const s = sessions.get(name)
  if (!s?.ws || s.ws.readyState !== WebSocket.OPEN) throw new Error(`session "${name}" is not connected`)
  const msg = { type, messageId: messageId ?? randomUUID(), commandId }
  if (data !== undefined) msg.data = data
  s.ws.send(JSON.stringify(msg))
  log(name, 'out', msg)
  return msg.messageId
}

function sendRaw(name, text) {
  const s = sessions.get(name)
  if (!s?.ws || s.ws.readyState !== WebSocket.OPEN) throw new Error(`session "${name}" is not connected`)
  s.ws.send(text)
  let msg
  try {
    msg = JSON.parse(text)
  } catch {
    msg = { raw: text }
  }
  log(name, 'out', msg)
}

// ---- token generation (shells out to the teiserver mix task) -----------------

function genToken(user, app) {
  return new Promise((resolve, reject) => {
    const args = ['teiserver.gen_token', '--user', user, '--app', app || 'generic_lobby']
    const p = spawn('mix', args, { cwd: CONFIG.teiserverDir, env: process.env })
    let out = ''
    p.stdout.on('data', (d) => (out += d))
    p.stderr.on('data', (d) => (out += d))
    p.on('error', reject)
    p.on('close', () => {
      const m = out.match(/Generated token \(id=\d+\) - (\S+)/)
      if (m) resolve(m[1])
      else reject(new Error(out.trim().split('\n').slice(-3).join('\n') || 'no token produced'))
    })
  })
}

// ---- HTTP + UI websocket -----------------------------------------------------

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }

const server = http.createServer((req, res) => {
  const urlPath = req.url === '/' ? '/index.html' : req.url.split('?')[0]
  const file = path.join(ROOT, 'public', path.normalize(urlPath).replace(/^(\.\.[/\\])+/, ''))
  if (!file.startsWith(path.join(ROOT, 'public')) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404).end('not found')
    return
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' })
  fs.createReadStream(file).pipe(res)
})

const wss = new WebSocketServer({ server, path: '/ui' })

wss.on('connection', (ui) => {
  uiClients.add(ui)
  ui.on('close', () => uiClients.delete(ui))
  ui.send(
    JSON.stringify({
      op: 'init',
      envs: ENVS,
      toolbox,
      local: { status: local.status, managed: local.managed, logs: localLogs },
      config: { defaultUrl: CONFIG.defaultUrl, clientId: CONFIG.clientId, tachyonDir: CONFIG.tachyonDir, teiserverDir: CONFIG.teiserverDir },
      catalog,
      sessions: [...sessions.values()].map(publicSession),
      scenarios: listScenarios(path.join(ROOT, 'scenarios'))
    })
  )

  ui.on('message', async (raw) => {
    let m
    try {
      m = JSON.parse(raw.toString())
    } catch {
      return
    }
    const reply = (payload) => ui.send(JSON.stringify({ reqId: m.reqId, ...payload }))
    try {
      switch (m.op) {
        case 'connect':
          connect(m).catch((err) => reply({ op: 'error', message: err.message }))
          break
        case 'disconnect':
          disconnect(m.name)
          break
        case 'removeSession':
          removeSession(m.name)
          break
        case 'send':
          // `${bob.id}` style placeholders are resolved from the connected sessions
          send(m.name, { ...m, data: m.data === undefined ? undefined : subst(m.data, sessions) })
          break
        case 'toolboxSave': {
          const item = { id: m.item.id ?? randomUUID(), name: m.item.name, as: m.item.as ?? null, commandId: m.item.commandId, data: m.item.data }
          const i = toolbox.findIndex((t) => t.id === item.id || t.name === item.name)
          if (i >= 0) toolbox[i] = { ...item, id: toolbox[i].id }
          else toolbox.push(item)
          saveToolbox()
          break
        }
        case 'toolboxDelete':
          toolbox = toolbox.filter((t) => t.id !== m.id)
          saveToolbox()
          break
        case 'raw':
          sendRaw(m.name, m.text)
          break
        case 'genToken':
          reply({ op: 'token', token: await genToken(m.user, m.app) })
          break
        case 'localStart':
          local.ensureUp().catch((err) => broadcast({ op: 'localLog', text: `start failed: ${err.message}\n` }))
          break
        case 'localStop':
          await local.stop({ force: !!m.force }).catch((err) => reply({ op: 'error', where: 'local', message: err.message }))
          break
        case 'oauthLogin': {
          const { authUrl, result } = await startLogin({ base: ENVS.dev.base, clientId: CONFIG.clientId })
          reply({ op: 'authUrl', url: authUrl, loginId: m.loginId })
          result
            .then((t) => broadcast({ op: 'oauthDone', loginId: m.loginId, ...t }))
            .catch((err) => broadcast({ op: 'oauthDone', loginId: m.loginId, error: err.message }))
          break
        }
        case 'runScenario': {
          const scenarios = listScenarios(path.join(ROOT, 'scenarios'))
          const sc = scenarios.find((s) => s.file === m.file)
          if (!sc) throw new Error('unknown scenario')
          runScenario(sc, {
            sessions,
            send,
            connect,
            onLog: (e) => broadcast({ op: 'scenarioLog', ...e }),
            listen: (fn) => {
              scenarioListeners.add(fn)
              return () => scenarioListeners.delete(fn)
            }
          })
          break
        }
      }
    } catch (err) {
      reply({ op: 'error', message: err.message })
    }
  })
})

loadSavedSessions()
local.refresh()
setInterval(() => local.refresh(), 5000).unref()
server.listen(CONFIG.port, '127.0.0.1', () => {
  console.log(`TachyonDebug on http://localhost:${CONFIG.port}`)
  console.log(`  schemas: ${path.join(CONFIG.tachyonDir, 'schema')} (${catalog.commands.length} commands)`)
  if (catalog.error) console.warn(`  WARNING: ${catalog.error} (set TACHYON_DIR)`)
})
