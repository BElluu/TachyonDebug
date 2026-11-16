// Manages a local Teiserver checkout: detects whether it is up and starts it
// (Postgres first, then `mix phx.server`) when it is not.
import http from 'node:http'
import { spawn, spawnSync } from 'node:child_process'

export function isUp(httpUrl, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get(httpUrl, (res) => {
      res.resume()
      resolve(true)
    })
    req.setTimeout(timeoutMs, () => req.destroy())
    req.on('error', () => resolve(false))
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// `commands` lets tests (or unusual setups) replace what gets run: { pg, server } as [cmd, args]
// pairs; `pg: null` skips the Postgres step.
export function createLocalServer({ dir, httpUrl, onChange, onLog, startTimeoutMs = 240_000, commands = {} }) {
  const mise = spawnSync('mise', ['--version']).status === 0
  // `mise exec` applies the project's mise.toml env (PGPASSWORD, TLS paths...) and tool versions
  const wrap = (cmd, args) => (mise ? ['mise', ['exec', '--', cmd, ...args]] : [cmd, args])

  const self = {
    status: 'unknown', // unknown | down | starting | up | stopping
    managed: false, // true when we spawned the process (so we are allowed to stop it)
    child: null,
    starting: null
  }
  const set = (status) => {
    self.status = status
    onChange({ status, managed: self.managed })
  }

  function run(label, cmd, args) {
    return new Promise((resolve, reject) => {
      const [c, a] = wrap(cmd, args)
      onLog(`$ ${label}`)
      const p = spawn(c, a, { cwd: dir, env: process.env })
      p.stdout.on('data', (d) => onLog(d.toString()))
      p.stderr.on('data', (d) => onLog(d.toString()))
      p.on('error', reject)
      p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${label} exited with ${code}`))))
    })
  }

  async function startPostgres() {
    if (commands.pg === null) return
    if (commands.pg) return run('pg', commands.pg[0], commands.pg[1])
    await run('mise run pg:start', 'mise', ['run', 'pg:start']).catch(() =>
      // no mise task available: fall back to starting pg_ctl directly
      run('pg_ctl start', 'pg_ctl', ['-D', 'tmp/postgres/data', '-l', 'tmp/postgres.log', 'start'])
    )
  }
  self.ensurePostgres = startPostgres

  self.refresh = async () => {
    if (self.status === 'starting' || self.status === 'stopping') return self.status
    set((await isUp(httpUrl)) ? 'up' : 'down')
    return self.status
  }

  // Resolves once the server answers HTTP. Safe to call concurrently.
  self.ensureUp = () => {
    if (self.starting) return self.starting
    self.starting = (async () => {
      if (await isUp(httpUrl)) return set('up')
      set('starting')
      try {
        await startPostgres()
        const [c, a] = commands.server ? commands.server : wrap('mix', ['phx.server'])
        onLog('$ mix phx.server')
        // detached => own process group, so we can kill beam and everything under it
        const child = spawn(c, a, { cwd: dir, env: { ...process.env, MIX_ENV: 'dev' }, detached: true })
        self.child = child
        self.managed = true
        child.stdout.on('data', (d) => onLog(d.toString()))
        child.stderr.on('data', (d) => onLog(d.toString()))
        child.on('close', (code) => {
          onLog(`mix phx.server exited (${code})`)
          self.child = null
          self.managed = false
          if (self.status !== 'stopping') set('down')
        })
        const deadline = Date.now() + startTimeoutMs
        while (Date.now() < deadline) {
          if (!self.child) throw new Error('mix phx.server exited before becoming ready (see server log)')
          if (await isUp(httpUrl)) return set('up')
          await sleep(1000)
        }
        throw new Error('timed out waiting for the local server to start')
      } catch (err) {
        set('down')
        throw err
      }
    })().finally(() => (self.starting = null))
    return self.starting
  }

  // Find whoever listens on the server port (used to stop a server we did not start).
  function listeningPids() {
    const port = new URL(httpUrl).port || '80'
    const ss = spawnSync('ss', ['-ltnpH', `sport = :${port}`], { encoding: 'utf8' })
    const fromSs = [...(ss.stdout ?? '').matchAll(/pid=(\d+)/g)].map((m) => Number(m[1]))
    if (fromSs.length) return [...new Set(fromSs)]
    const lsof = spawnSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' })
    return (lsof.stdout ?? '').split(/\s+/).filter(Boolean).map(Number)
  }

  // `force` allows stopping a server that was started outside of TachyonDebug.
  self.stop = async ({ force = false } = {}) => {
    if (!self.child) {
      if (!force) throw new Error('local server was not started by TachyonDebug, refusing to stop it')
      const pids = listeningPids()
      if (!pids.length) throw new Error(`could not find the process listening on ${httpUrl} (try stopping it in its terminal)`)
      set('stopping')
      onLog(`stopping external server, pid ${pids.join(', ')}\n`)
      for (const pid of pids) {
        try { process.kill(pid, 'SIGTERM') } catch (err) { onLog(`kill ${pid}: ${err.message}\n`) }
      }
      for (let i = 0; i < 30 && (await isUp(httpUrl)); i++) await sleep(500)
      set((await isUp(httpUrl)) ? 'up' : 'down')
      if (self.status === 'up') throw new Error('the server is still answering after SIGTERM')
      return
    }
    set('stopping')
    try {
      process.kill(-self.child.pid, 'SIGTERM')
    } catch {
      /* already gone */
    }
    for (let i = 0; i < 30 && self.child; i++) await sleep(500)
    if (self.child) {
      try { process.kill(-self.child.pid, 'SIGKILL') } catch { /* gone */ }
    }
    set('down')
  }

  // don't leave an orphan beam behind when TachyonDebug exits
  const cleanup = () => {
    if (self.child) {
      try { process.kill(-self.child.pid, 'SIGTERM') } catch { /* gone */ }
    }
  }
  process.on('exit', cleanup)
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { cleanup(); process.exit(0) })

  return self
}
