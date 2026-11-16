// Scenarios: JSON files describing a scripted flow over several client sessions.
//
// {
//   "name": "...", "description": "...",
//   "sessions": ["alice", "bob"],            // must already be connected
//   "steps": [
//     { "as": "alice", "command": "party/create" },
//     { "as": "alice", "command": "party/invite", "data": { "userId": "${bob.id}" } },
//     { "as": "bob",   "waitFor": "party/invited" },
//     { "sleep": 500 },
//     { "as": "alice", "command": "party/invite", "expect": { "status": "failed" } }
//   ]
// }
//
// `${name.id}` / `${name.name}` are replaced with the user id / name learned from `user/self`.
// A step can `capture` values from its response (or the awaited event) into variables:
//   "capture": { "party": "data.party", "queue": "data.playlists.teamSize=2" }
// A path segment is an object key, an array index, or `field=value` to pick the first
// array element whose field matches. Variables are used as `${party.id}`, `${queue.version}`.
// `expect` is a shallow-recursive subset match against the response.
import fs from 'node:fs'
import path from 'node:path'

export function listScenarios(dir) {
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .flatMap((file) => {
      try {
        const sc = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'))
        return [{ file, name: sc.name ?? file, description: sc.description ?? '', sessions: sc.sessions ?? [], steps: sc.steps ?? [] }]
      } catch (err) {
        return [{ file, name: file, description: `invalid JSON: ${err.message}`, sessions: [], steps: [] }]
      }
    })
}

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
      if (v == null) throw new Error(`cannot resolve \${${expr}} (session not connected, or nothing captured yet)`)
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
  if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
    return actual && typeof actual === 'object' && Object.entries(expected).every(([k, v]) => matches(actual[k], v))
  }
  return JSON.stringify(actual) === JSON.stringify(expected)
}

export async function runScenario(sc, ctx, { timeoutMs = 5000 } = {}) {
  const { sessions, send, onLog, listen } = ctx
  onLog({ scenario: sc.file, status: 'start', name: sc.name })

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

  const waitFor = (predicate, label) => {
    const idx = inbox.findIndex(predicate)
    if (idx >= 0) return Promise.resolve(inbox.splice(idx, 1)[0].msg)
    return new Promise((resolve, reject) => {
      const w = { predicate, resolve }
      w.timer = setTimeout(() => {
        waiters.delete(w)
        reject(new Error(`timeout waiting for ${label}`))
      }, timeoutMs)
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

  for (const [i, step] of sc.steps.entries()) {
    const report = (status, detail) => onLog({ scenario: sc.file, step: i, status, detail })
    try {
      if (step.sleep) {
        await new Promise((r) => setTimeout(r, step.sleep))
      } else if (step.command) {
        const data = step.data === undefined ? undefined : subst(step.data, sessions, vars)
        // register the listener before sending so a fast reply cannot be missed
        let messageId
        const reply = waitFor((e) => e.session === step.as && e.msg?.type === 'response' && e.msg?.messageId === messageId, `response to ${step.command}`)
        messageId = send(step.as, { commandId: step.command, data })
        const resp = await reply
        if (step.expect && !matches(resp, step.expect)) {
          throw new Error(`unexpected response: ${JSON.stringify(resp)}`)
        }
        capture(step, resp)
      } else if (step.waitFor) {
        const expected = step.expect
        const evt = await waitFor(
          (e) => e.session === step.as && e.msg?.commandId === step.waitFor && (!expected || matches(e.msg, expected)),
          `${step.waitFor} for ${step.as}`
        )
        capture(step, evt)
      }
      report('ok')
    } catch (err) {
      report('failed', err.message)
      onLog({ scenario: sc.file, status: 'aborted' })
      unlisten()
      return false
    }
  }
  unlisten()
  onLog({ scenario: sc.file, status: 'done' })
  return true
}
