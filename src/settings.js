// User settings (where the Teiserver / Tachyon checkouts live, URLs...) persisted in data/settings.json.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const expandHome = (p) => (typeof p === 'string' && p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p)

export function defaults(root) {
  const parent = path.dirname(root)
  return {
    setupDone: false,
    teiserverDir: process.env.TEISERVER_DIR ?? path.join(parent, 'teiserver'),
    tachyonDir: process.env.TACHYON_DIR ?? path.join(parent, 'tachyon'),
    localUrl: process.env.TACHYON_URL ?? 'ws://localhost:4000/tachyon',
    devUrl: process.env.TACHYON_DEV_URL ?? 'https://lobby-server-dev.beyondallreason.dev',
    clientId: process.env.TACHYON_CLIENT_ID ?? 'generic_lobby',
    autostart: true
  }
}

export function createSettings(dataDir, root) {
  const file = path.join(dataDir, 'settings.json')
  let current = defaults(root)
  let existed = false
  try {
    current = { ...current, ...JSON.parse(fs.readFileSync(file, 'utf8')) }
    existed = true
  } catch {
    /* first run */
  }
  return {
    get: () => current,
    existed,
    save(patch) {
      current = { ...current, ...patch }
      for (const k of ['teiserverDir', 'tachyonDir']) current[k] = path.resolve(expandHome(current[k] ?? ''))
      fs.writeFileSync(file, JSON.stringify(current, null, 2))
      return current
    }
  }
}

const isDir = (p) => {
  try { return fs.statSync(p).isDirectory() } catch { return false }
}
const read = (p) => {
  try { return fs.readFileSync(p, 'utf8') } catch { return null }
}

export function checkTeiserver(dir) {
  const d = path.resolve(expandHome(dir ?? ''))
  if (!isDir(d)) return { ok: false, message: 'Folder does not exist' }
  const mix = read(path.join(d, 'mix.exs'))
  if (mix === null) return { ok: false, message: 'No mix.exs here, this is not an Elixir project' }
  if (!/app:\s*:teiserver\b/.test(mix)) return { ok: false, message: 'mix.exs is not the Teiserver project' }
  const bits = []
  bits.push(fs.existsSync(path.join(d, 'deps')) ? 'deps fetched' : 'deps NOT fetched (run mix deps.get)')
  bits.push(fs.existsSync(path.join(d, 'mise.toml')) ? 'mise.toml found' : 'no mise.toml')
  return { ok: true, message: `Teiserver checkout, ${bits.join(', ')}` }
}

export function checkTachyon(dir) {
  const d = path.resolve(expandHome(dir ?? ''))
  if (!isDir(d)) return { ok: false, message: 'Folder does not exist' }
  if (!isDir(path.join(d, 'schema'))) return { ok: false, message: 'No schema/ folder here' }
  let version = ''
  try { version = ` v${JSON.parse(read(path.join(d, 'package.json'))).version}` } catch { /* optional */ }
  return { ok: true, message: `Tachyon protocol${version}` }
}

// Look around for likely checkouts: siblings of this app, ~/code/*, ~/*.
export function detect(root) {
  const roots = [path.dirname(root), path.join(os.homedir(), 'code'), os.homedir()]
  const seen = new Set()
  const found = { teiserver: [], tachyon: [] }
  for (const r of roots) {
    let entries = []
    try { entries = fs.readdirSync(r, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue
      const p = path.join(r, e.name)
      if (seen.has(p)) continue
      seen.add(p)
      if (checkTeiserver(p).ok) found.teiserver.push(p)
      if (checkTachyon(p).ok) found.tachyon.push(p)
    }
  }
  return found
}
