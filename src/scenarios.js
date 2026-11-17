// Scenarios: JSON files describing a scripted flow over several client sessions.
//
// {
//   "name": "...", "category": "Party", "description": "...",
//   "sessions": ["player1", "player2"],            // players that must already be connected
//   "steps": [
//     { "as": "player1", "command": "party/create", "expect": { "status": "success" } },
//     { "as": "player1", "command": "party/invite", "data": { "userId": "${player2.id}" } },
//     { "as": "player2",   "waitFor": "party/invited", "capture": { "party": "data.party" } },
//     { "as": "player2",   "drain": true },                         // forget events received so far
//     { "as": "player2",   "expectNo": "party/updated", "within": 400 },
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
// Robustness / connection steps:
//   { "as": "player1", "raw": "{not json" }                      // send this text frame verbatim (a string is sent as is,
//   { "as": "player1", "raw": { "type": "request" } }             //  an object is JSON.stringify'd, so it may be malformed protocol-wise)
//        optional: "waitReply": true (await the next message of that player, `expect` is matched against it),
//                  "expectClose": true (the server must drop the connection)
//   { "as": "player1", "disconnect": "terminate" }                // "close" (clean) or "terminate" (abrupt, no close frame)
//   { "as": "player1", "reconnect": true }                        // connect again with the stored token, wait until open
//                         "ifClosed" reconnects only when the server dropped the connection (use it after bad-input tests)
// Schema checking: every response / awaited event is validated against the protocol schema. A mismatch is
// reported as a warning; set "schema": "fail" on a step (or run with strict schema checking) to make it fail,
// or "schema": "off" to skip the check.
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
          issue: typeof sc.issue === 'string' ? sc.issue : null,
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

export async function runScenario(sc, ctx, opts = {}) {
  const { timeoutMs = 5000 } = opts
  const { sessions, send, onLog, listen } = ctx
  const schemaMode = opts.schema ?? 'warn' // 'off' | 'warn' | 'fail'
  // `roles` maps the player names a scenario is written with (player1, player2) to the sessions that play them
  const real = (n) => opts.roles?.[n] ?? n
  const view = { get: (n) => sessions.get(real(n)) }
  const steps = sc.steps.map((s) => ({ ...s, ...(s.as ? { as: real(s.as) } : {}), ...(typeof s.drain === 'string' && s.drain !== 'all' ? { drain: real(s.drain) } : {}) }))
  const id = sc.id ?? sc.file
  onLog({ scenario: id, status: 'start', name: sc.name })

  // every player the scenario talks through must be connected before we start
  const needed = (sc.sessions?.length ? sc.sessions : playersOf(sc.steps)).map(real)
  if (new Set(needed).size !== needed.length) {
    onLog({ scenario: id, status: 'aborted', detail: 'two roles are played by the same session, pick different players' })
    return false
  }
  const missing = needed.filter((n) => sessions.get(n)?.state !== 'open')
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

  // short text for a message that was not what we wanted: `failed (party_in_matchmaking)`, or the event name
  const describeMsg = (m) => {
    if (m?.type === 'response') return `${m.status}${m.reason ? ` (${m.reason})` : ''}${m.details ? `: ${m.details}` : ''}`
    const t = JSON.stringify(m?.data)
    return `${m?.commandId ?? m?.type ?? 'message'}${t && t !== '{}' ? ` ${t.length > 120 ? t.slice(0, 117) + '…' : t}` : ''}`
  }
  const waitFor = (predicate, label, ms, who) => {
    const idx = inbox.findIndex(predicate)
    if (idx >= 0) return Promise.resolve(inbox.splice(idx, 1)[0].msg)
    return new Promise((resolve, reject) => {
      const w = { predicate, resolve }
      w.timer = setTimeout(() => {
        waiters.delete(w)
        const others = who ? inbox.filter((e) => e.session === who).slice(-5).map((e) => describeMsg(e.msg)) : []
        reject(new Error(`timeout (${ms} ms) waiting for ${label}${others.length ? `. ${who} received instead: ${others.join(' | ')}` : who ? `. ${who} received nothing else` : ''}`))
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

  // schema check of a received message; returns the issues (to report) or throws in strict mode
  const checkSchema = (step, msg, kind) => {
    const mode = step.schema ?? schemaMode
    if (mode === 'off' || !ctx.validate) return undefined
    const r = ctx.validate(msg, kind)
    if (!r.known || !r.issues.length) return undefined
    if (mode === 'fail') throw new Error(`does not match the ${kind} schema: ${r.issues.map((x) => `${x.path} ${x.message}`).join('; ')}`)
    return r.issues
  }
  const rawText = (step) => {
    const raw = typeof step.raw === 'string' ? subst(step.raw, view, vars) : JSON.stringify(subst(step.raw, view, vars))
    return raw
  }
  const waitState = async (name, wanted, ms) => {
    const end = Date.now() + ms
    while (Date.now() < end) {
      if (sessions.get(name)?.state === wanted) return
      await new Promise((r) => setTimeout(r, 40))
    }
    throw new Error(`timeout (${ms} ms) waiting for ${name} to be ${wanted}`)
  }

  let failed = false
  for (const [i, step] of steps.entries()) {
    const started = Date.now()
    const report = (status, extra = {}) => onLog({ scenario: id, step: i, status, ms: Date.now() - started, ...extra })
    const ms = step.timeout ?? timeoutMs
    report('running')
    let result
    let schemaIssues
    try {
      if (step.sleep) {
        await new Promise((r) => setTimeout(r, step.sleep))
      } else if (step.command) {
        const data = step.data === undefined ? undefined : subst(step.data, view, vars)
        // register the listener before sending so a fast reply cannot be missed
        let messageId
        const reply = waitFor((e) => e.session === step.as && e.msg?.type === 'response' && e.msg?.messageId === messageId, `the response to ${step.command}`, ms, step.as)
        messageId = send(step.as, { commandId: step.command, data })
        result = await reply
        schemaIssues = checkSchema(step, result, 'response')
        if (step.expect && !step.optional && !matches(result, subst(step.expect, view, vars))) {
          throw new Error(`unexpected response: got ${describeMsg(result)}, wanted ${JSON.stringify(step.expect)}`)
        }
        if (!step.optional) capture(step, result)
      } else if (step.waitFor) {
        const expected = step.expect && subst(step.expect, view, vars)
        result = await waitFor(
          (e) => e.session === step.as && e.msg?.commandId === step.waitFor && (!expected || matches(e.msg, expected)),
          `${step.waitFor} for ${step.as}`, ms, step.as)
        schemaIssues = checkSchema(step, result, 'event')
        capture(step, result)
      } else if (step.raw !== undefined) {
        if (!ctx.sendRaw) throw new Error('raw frames are not supported here')
        const text = rawText(step)
        const wanted = step.expect ? subst(step.expect, view, vars) : null
        const reply = step.waitReply ? waitFor((e) => e.session === step.as && (!wanted || matches(e.msg, wanted)), wanted ? `the reply to the raw frame for ${step.as}` : `any reply to the raw frame for ${step.as}`, ms) : null
        const closed = step.expectClose ? waitState(step.as, 'closed', ms) : null
        ctx.sendRaw(step.as, text)
        if (reply) {
          result = await reply
          capture(step, result)
        }
        if (closed) await closed
      } else if (step.disconnect) {
        if (!ctx.drop) throw new Error('dropping connections is not supported here')
        ctx.drop(step.as, step.disconnect === 'close' ? 'close' : 'terminate')
        await waitState(step.as, 'closed', ms)
      } else if (step.reconnect) {
        if (!ctx.reconnect) throw new Error('reconnecting is not supported here')
        if (step.reconnect === 'ifClosed' && sessions.get(step.as)?.state === 'open') { /* still connected, nothing to do */ } else await ctx.reconnect(step.as, ms)
      } else if (step.expectNo) {
        const hit = (e) => e.session === step.as && e.msg?.commandId === step.expectNo
        const unexpected = () => new Error(`${step.as} received ${step.expectNo}, which was not expected`)
        if (inbox.some(hit)) throw unexpected()
        if (await waitFor(hit, step.expectNo, step.within ?? 500).then(() => true, () => false)) throw unexpected()
      } else if (step.drain) {
        const who = step.as ?? (typeof step.drain === 'string' ? step.drain : null)
        for (let k = inbox.length - 1; k >= 0; k--) if (!who || who === 'all' || inbox[k].session === who) inbox.splice(k, 1)
      }
      report('ok', { ...(result ? { response: result } : {}), ...(schemaIssues ? { schemaIssues } : {}) })
    } catch (err) {
      if (step.optional) {
        report('skipped', { detail: err.message, ...(result ? { response: result } : {}) })
        continue
      }
      report('failed', { detail: err.message, ...(result ? { response: result } : {}) })
      failed = true
      break
    }
  }
  unlisten()
  onLog({ scenario: id, status: failed ? 'aborted' : 'done' })
  return !failed
}
