// Scenarios: JSON files describing a scripted flow over several client sessions.
//
// {
//   "name": "...", "category": "Party", "description": "...",
//   "sessions": ["alice", "bob"],            // players that must already be connected
//   "steps": [
//     { "as": "alice", "command": "party/create", "expect": { "status": "success" } },
//     { "as": "alice", "command": "party/invite", "data": { "userId": "${bob.id}" } },
//     { "as": "bob",   "waitFor": "party/invited", "capture": { "party": "data.party" } },
//     { "as": "bob",   "drain": true },                         // forget events received so far
//     { "as": "bob",   "expectNo": "party/updated", "within": 400 },
//     { "sleep": 500 }
//   ]
// }
//
// Common step fields: `title` (shown in the UI), `note`, `optional` (a failure is reported but does
// not stop the run, handy for cleanup/reset steps) and `timeout` (ms, default 5000).
// `${name.id}` / `${name.name}` are replaced with the user id / name learned from `user/self`.
// A step can `capture` values from its response (or the awaited event) into variables:
//   "capture": { "party": "data.party", "queue": "data.playlists.teamSize=2" }
// A path segment is an object key, an array index, or `field=value` to pick the first array element
// whose field matches. Variables are used as `${party.id}`, `${queue.version}`.
// `expect` is a recursive subset match against the response (or the awaited event).
import fs from 'node:fs'
import path from 'node:path'

export function listScenarios(dir, source) {
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .flatMap((file) => {
      const id = `${source}:${file}`
      try {
        const sc = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'))
        return [{
          id, file, source,
          name: sc.name ?? file,
          category: sc.category ?? (source === 'user' ? 'Custom' : 'Other'),
          description: sc.description ?? '',
          sessions: sc.sessions ?? playersOf(sc.steps ?? []),
          steps: sc.steps ?? []
        }]
      } catch (err) {
        return [{ id, file, source, name: file, category: 'Broken', description: `invalid JSON: ${err.message}`, sessions: [], steps: [], broken: true }]
      }
    })
}

export const playersOf = (steps) => [...new Set(steps.map((s) => s.as).filter(Boolean))]

export function getPath(obj, pathStr) {
  let cur = obj
  for (const seg of pathStr.split('.')) {
    if (cur == null) return undefined
    if (seg.includes('=') && Array.isArray(cur)) {
      const [field, val] = seg.split('=')
      cur = cur.find((el) => String(el?.[field]) === val)
    } else {
      cur = cur[seg]
    }
  }
  return cur
}

export function subst(value, sessions, vars = new Map()) {
  if (typeof value === 'string') {
    return value.replace(/\$\{([\w.=]+)\}/g, (_m, expr) => {
      const [head, ...rest] = expr.split('.')
      const user = sessions.get(head)?.user
      let v = user && rest.length === 1 && rest[0] in user ? user[rest[0]] : undefined
      if (v === undefined && vars.has(head)) v = rest.length ? getPath(vars.get(head), rest.join('.')) : vars.get(head)
      if (v == null) throw new Error(`cannot resolve \${${expr}} (is "${head}" connected, or was it never captured?)`)
      return String(v)
    })
  }
  if (Array.isArray(value)) return value.map((v) => subst(v, sessions, vars))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, subst(v, sessions, vars)]))
  }
  return value
}

export function matches(actual, expected) {
  if (Array.isArray(expected)) return Array.isArray(actual) && expected.every((e, i) => matches(actual[i], e))
  if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
    return actual && typeof actual === 'object' && Object.entries(expected).every(([k, v]) => matches(actual[k], v))
  }
  return JSON.stringify(actual) === JSON.stringify(expected)
}

export async function runScenario(sc, ctx, { timeoutMs = 5000 } = {}) {
  const { sessions, send, onLog, listen } = ctx
  const id = sc.id ?? sc.file
  onLog({ scenario: id, status: 'start', name: sc.name })

  // every player the scenario talks through must be connected before we start
  const missing = (sc.sessions?.length ? sc.sessions : playersOf(sc.steps)).filter((n) => sessions.get(n)?.state !== 'open')
  if (missing.length) {
    onLog({ scenario: id, status: 'aborted', detail: `these players are not connected: ${missing.join(', ')}` })
    return false
  }

  // Buffer every incoming message for the duration of the scenario, so an event that
  // lands before its `waitFor` step starts is not lost. Each message is consumed once.
  const inbox = []
  const waiters = new Set()
  const unlisten = listen((entry) => {
    if (entry.dir !== 'in') return
    for (const w of waiters) {
      if (w.predicate(entry)) {
        waiters.delete(w)
        clearTimeout(w.timer)
        w.resolve(entry.msg)
        return
      }
    }
    inbox.push(entry)
  })

  const waitFor = (predicate, label, ms) => {
    const idx = inbox.findIndex(predicate)
    if (idx >= 0) return Promise.resolve(inbox.splice(idx, 1)[0].msg)
    return new Promise((resolve, reject) => {
      const w = { predicate, resolve }
      w.timer = setTimeout(() => {
        waiters.delete(w)
        reject(new Error(`timeout (${ms} ms) waiting for ${label}`))
      }, ms)
      waiters.add(w)
    })
  }

  const vars = new Map()
  const capture = (step, msg) => {
    for (const [name, p] of Object.entries(step.capture ?? {})) {
      const v = getPath(msg, p)
      if (v === undefined) throw new Error(`capture "${name}": nothing at ${p}`)
      vars.set(name, v)
    }
  }

  let failed = false
  for (const [i, step] of sc.steps.entries()) {
    const started = Date.now()
    const report = (status, extra = {}) => onLog({ scenario: id, step: i, status, ms: Date.now() - started, ...extra })
    const ms = step.timeout ?? timeoutMs
    report('running')
    try {
      let result
      if (step.sleep) {
        await new Promise((r) => setTimeout(r, step.sleep))
      } else if (step.command) {
        const data = step.data === undefined ? undefined : subst(step.data, sessions, vars)
        // register the listener before sending so a fast reply cannot be missed
        let messageId
        const reply = waitFor((e) => e.session === step.as && e.msg?.type === 'response' && e.msg?.messageId === messageId, `the response to ${step.command}`, ms)
        messageId = send(step.as, { commandId: step.command, data })
        result = await reply
        if (step.expect && !step.optional && !matches(result, subst(step.expect, sessions, vars))) {
          throw new Error(`unexpected response, wanted ${JSON.stringify(step.expect)}`)
        }
        if (!step.optional) capture(step, result)
      } else if (step.waitFor) {
        const expected = step.expect && subst(step.expect, sessions, vars)
        result = await waitFor(
          (e) => e.session === step.as && e.msg?.commandId === step.waitFor && (!expected || matches(e.msg, expected)),
          `${step.waitFor} for ${step.as}`, ms)
        capture(step, result)
      } else if (step.expectNo) {
        const hit = (e) => e.session === step.as && e.msg?.commandId === step.expectNo
        const unexpected = () => new Error(`${step.as} received ${step.expectNo}, which was not expected`)
        if (inbox.some(hit)) throw unexpected()
        if (await waitFor(hit, step.expectNo, step.within ?? 500).then(() => true, () => false)) throw unexpected()
      } else if (step.drain) {
        const who = step.as ?? (typeof step.drain === 'string' ? step.drain : null)
        for (let k = inbox.length - 1; k >= 0; k--) if (!who || who === 'all' || inbox[k].session === who) inbox.splice(k, 1)
      }
      report('ok', result ? { response: result } : {})
    } catch (err) {
      if (step.optional) {
        report('skipped', { detail: err.message })
        continue
      }
      report('failed', { detail: err.message })
      failed = true
      break
    }
  }
  unlisten()
  onLog({ scenario: id, status: failed ? 'aborted' : 'done' })
  return !failed
}
