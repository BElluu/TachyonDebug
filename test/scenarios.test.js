import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { buildCatalog } from '../src/catalog.js'
import { listScenarios, runScenario, matches } from '../src/scenarios.js'
import { parseImport } from '../public/js/io.js'
import { parseIssueUrl } from '../public/js/issue.js'
import { createValidator } from '../src/validate.js'
import { blank, reduce } from '../public/js/derive.js'

const schemaDir = path.resolve(process.env.TACHYON_DIR ?? '../tachyon', 'schema')

// ---- the shipped scenarios must make sense against the protocol schemas ----
test('built-in scenarios are valid JSON with known commands, events and variables', { skip: !fs.existsSync(schemaDir) }, () => {
  const catalog = buildCatalog(schemaDir).commands
  const requests = new Set(catalog.filter((c) => c.kinds.request).map((c) => c.id))
  const events = new Set(catalog.filter((c) => c.kinds.event).map((c) => c.id))
  const list = listScenarios('scenarios', 'builtin')
  assert.ok(list.length >= 20, 'expected a decent set of scenarios')
  for (const sc of list) {
    assert.ok(!sc.broken, `${sc.file} is not valid JSON`)
    assert.ok(sc.name && sc.category && sc.steps.length, `${sc.file}: name, category and steps are required`)
    const players = new Set(sc.sessions)
    const captured = new Set()
    for (const [i, s] of sc.steps.entries()) {
      const where = `${sc.file} step ${i + 1}`
      if (s.command) assert.ok(requests.has(s.command), `${where}: unknown command ${s.command}`)
      if (s.waitFor) assert.ok(events.has(s.waitFor), `${where}: unknown event ${s.waitFor}`)
      if (s.expectNo) assert.ok(events.has(s.expectNo), `${where}: unknown event ${s.expectNo}`)
      if (s.as) assert.ok(players.has(s.as), `${where}: player ${s.as} is not listed in "sessions"`)
      assert.ok(s.command || s.waitFor || s.expectNo || s.drain || s.sleep || s.raw !== undefined || s.disconnect || s.reconnect, `${where}: not a recognised step`)
      // every ${var.x} must be a listed player or an earlier capture
      for (const [, head] of JSON.stringify([s.data, s.expect]).matchAll(/\$\{(\w+)[.}]/g)) {
        assert.ok(players.has(head) || captured.has(head), `${where}: \${${head}} is neither a player nor captured before`)
      }
      for (const k of Object.keys(s.capture ?? {})) captured.add(k)
    }
  }
})

// ---- engine ----
function harness(players = ['alice', 'bob']) {
  const sessions = new Map(players.map((n, i) => [n, { state: 'open', user: { id: String(i + 1), name: n } }]))
  const listeners = new Set()
  const emit = (e) => [...listeners].forEach((fn) => fn(e))
  const logs = []
  const sent = []
  return {
    sessions, emit, logs, sent,
    ctx: {
      sessions,
      onLog: (l) => logs.push(l),
      listen: (fn) => (listeners.add(fn), () => listeners.delete(fn)),
      send: (name, { commandId, data }) => {
        const messageId = `m${sent.length}`
        sent.push({ name, commandId, data })
        setImmediate(() => emit({ dir: 'in', session: name, msg: { type: 'response', messageId, commandId, status: commandId === 'bad' ? 'failed' : 'success' } }))
        return messageId
      }
    }
  }
}

test('matches compares arrays element by element as subsets', () => {
  assert.ok(matches({ users: [{ id: 1, name: 'x' }] }, { users: [{ name: 'x' }] }))
  assert.ok(!matches({ users: [] }, { users: [{ name: 'x' }] }))
})

test('preflight: a scenario does not start when a player is offline', async () => {
  const h = harness()
  h.sessions.get('bob').state = 'closed'
  const ok = await runScenario({ id: 'x', name: 'x', sessions: ['alice', 'bob'], steps: [{ as: 'alice', command: 'a' }] }, h.ctx)
  assert.equal(ok, false)
  assert.match(h.logs.at(-1).detail, /bob/)
  assert.equal(h.sent.length, 0)
})

test('optional steps are skipped instead of failing the run', async () => {
  const h = harness()
  const ok = await runScenario({ id: 'x', name: 'x', steps: [
    { as: 'alice', command: 'bad', optional: true },
    { as: 'alice', command: 'good', expect: { status: 'success' } }
  ] }, h.ctx)
  assert.equal(ok, true)
  assert.equal(h.logs.filter((l) => l.status === 'ok').length, 2) // an optional step with an answer is simply ok
})

test('drain forgets buffered events, expectNo watches for them', async () => {
  const h = harness()
  const evt = (session, commandId) => h.emit({ dir: 'in', session, msg: { type: 'event', commandId, messageId: 'e' + Math.random() } })
  // a stale event must not satisfy a later waitFor once drained
  evt('alice', 'party/updated')
  const drained = await runScenario({ id: 'a', name: 'a', steps: [{ sleep: 1 }], sessions: ['alice'] }, h.ctx)
  assert.ok(drained)
  const p = runScenario({ id: 'b', name: 'b', steps: [{ drain: 'all' }, { as: 'alice', waitFor: 'party/updated', timeout: 50 }] }, h.ctx)
  setImmediate(() => evt('alice', 'party/updated')) // arrives while the drain/wait run, so it is NOT stale
  assert.equal(await p, true)

  // expectNo: passes when nothing comes, fails when it does
  const quiet = await runScenario({ id: 'c', name: 'c', steps: [{ as: 'alice', expectNo: 'party/updated', within: 40 }] }, h.ctx)
  assert.equal(quiet, true)
  const noisy = runScenario({ id: 'd', name: 'd', steps: [{ as: 'alice', expectNo: 'party/updated', within: 200 }] }, h.ctx)
  setTimeout(() => evt('alice', 'party/updated'), 30)
  assert.equal(await noisy, false)
  assert.match(h.logs.at(-2).detail, /not expected/)
})

test('step results carry timing and the response', async () => {
  const h = harness()
  await runScenario({ id: 'x', name: 'x', steps: [{ as: 'alice', command: 'a' }] }, h.ctx)
  const done = h.logs.find((l) => l.status === 'ok')
  assert.equal(typeof done.ms, 'number')
  assert.equal(done.response.status, 'success')
})

// ---- import parsing ----
test('parseImport understands every export shape and rejects garbage', () => {
  const req = { name: 'Invite', commandId: 'party/invite', data: { userId: '1' } }
  assert.equal(parseImport({ app: 'TachyonDebug', type: 'collections', collections: [{ name: 'P', requests: [req] }] }).collections[0].requests[0].commandId, 'party/invite')
  assert.equal(parseImport({ type: 'requests', from: 'Party', requests: [req] }).collections[0].name, 'Party')
  assert.equal(parseImport([req]).collections[0].name, 'Imported')
  assert.equal(parseImport({ scenarios: [{ name: 'S', steps: [] }] }).scenarios.length, 1)
  assert.equal(parseImport({ name: 'raw scenario', steps: [{ sleep: 1 }] }).scenarios[0].name, 'raw scenario')
  // fresh ids on every import
  assert.notEqual(parseImport([req]).collections[0].requests[0].id, parseImport([req]).collections[0].requests[0].id)
  assert.throws(() => parseImport({ hello: 1 }), /nothing to import/)
  assert.throws(() => parseImport({ app: 'Postman', collections: [] }), /not TachyonDebug/)
  assert.throws(() => parseImport([{ name: 'no command' }]), /commandId/)
})

// ---- schema validation ----
test('validator flags requests and responses that break the protocol schema', { skip: !fs.existsSync(schemaDir) }, () => {
  const v = createValidator(buildCatalog(schemaDir).full)
  assert.equal(v.validateRequestData('party/invite', { userId: '1' }).issues.length, 0)
  const bad = v.validateRequestData('party/invite', {})
  assert.ok(bad.known && bad.issues.some((i) => /userId/.test(i.message)))
  assert.equal(v.validateRequestData('does/notExist', {}).known, false)
  const resp = v.validate({ type: 'response', messageId: 'a', commandId: 'party/invite', status: 'failed', reason: 'made_up_reason' }, 'response')
  assert.ok(resp.issues.length > 0)
  assert.equal(v.validate({ type: 'response', messageId: 'a', commandId: 'party/invite', status: 'success' }, 'response').issues.length, 0)
})

test('catalog offers field help and a full template', { skip: !fs.existsSync(schemaDir) }, () => {
  const c = buildCatalog(schemaDir).commands.find((x) => x.id === 'party/invite').kinds.request
  assert.ok(c.fields.some((f) => f.name === 'userId' && f.required))
  assert.ok('userId' in c.fullTemplate)
})

test('schema mode: warn reports issues, fail stops the step, off ignores', async () => {
  const issues = [{ path: 'data', message: 'bad' }]
  const mk = () => { const h = harness(); h.ctx.validate = () => ({ known: true, issues }); return h }
  let h = mk()
  assert.equal(await runScenario({ id: 'x', name: 'x', steps: [{ as: 'alice', command: 'a' }] }, h.ctx), true)
  assert.deepEqual(h.logs.find((l) => l.status === 'ok').schemaIssues, issues)
  h = mk()
  assert.equal(await runScenario({ id: 'x', name: 'x', steps: [{ as: 'alice', command: 'a' }] }, h.ctx, { schema: 'fail' }), false)
  assert.match(h.logs.at(-2).detail, /schema/)
  h = mk()
  assert.equal(await runScenario({ id: 'x', name: 'x', steps: [{ as: 'alice', command: 'a', schema: 'off' }] }, h.ctx, { schema: 'fail' }), true)
})

// ---- robustness / connection steps ----
test('raw, disconnect and reconnect steps drive the connection helpers', async () => {
  const h = harness()
  const calls = []
  h.ctx.sendRaw = (name, text) => { calls.push(['raw', name, text]); setImmediate(() => h.emit({ dir: 'in', session: name, msg: { type: 'response', messageId: 'q', status: 'failed' } })) }
  h.ctx.drop = (name, mode) => { calls.push(['drop', name, mode]); h.sessions.get(name).state = 'closed' }
  h.ctx.reconnect = async (name) => { calls.push(['reconnect', name]); h.sessions.get(name).state = 'open' }
  const ok = await runScenario({ id: 'x', name: 'x', steps: [
    { as: 'alice', raw: '{oops', waitReply: true, expect: { status: 'failed' } },
    { as: 'alice', raw: { type: 'request' } },
    { as: 'alice', disconnect: 'terminate' },
    { as: 'alice', reconnect: 'ifClosed' },
    { as: 'alice', reconnect: 'ifClosed' } // already open: no second reconnect
  ] }, h.ctx)
  assert.equal(ok, true)
  assert.deepEqual(calls, [['raw', 'alice', '{oops'], ['raw', 'alice', '{"type":"request"}'], ['drop', 'alice', 'terminate'], ['reconnect', 'alice']])
})

// ---- player state ----
test('player state is derived from party, matchmaking and friend events', () => {
  const st = blank()
  const ev = (commandId, data, type = 'event') => reduce(st, { type, commandId, data, status: 'success' })
  ev('party/invited', { party: { id: 'p1', members: [], maxMembers: 2, invited: [] } })
  assert.equal(st.invites.length, 1)
  ev('party/updated', { id: 'p1', members: [{ userId: '1' }, { userId: '2' }], maxMembers: 2, invited: [] })
  assert.equal(st.party.members.length, 2)
  assert.equal(st.invites.length, 0)
  ev('matchmaking/queuesJoined', { queues: ['q1'] })
  assert.equal(st.mm.status, 'queued')
  ev('matchmaking/found', { queueId: 'q1', timeoutMs: 1000 })
  assert.equal(st.mm.status, 'found')
  ev('matchmaking/cancelled', { reason: 'intentional' })
  assert.equal(st.mm.status, 'idle')
  ev('friend/requestReceived', { from: '7' })
  assert.deepEqual(st.friends.incoming, ['7'])
  ev('friend/requestRejected', { from: '7' })
  assert.deepEqual(st.friends.incoming, [])
  ev('party/removed', { partyId: 'p1' })
  assert.equal(st.party, null)
  // failed responses change nothing
  reduce(st, { type: 'response', commandId: 'party/create', status: 'failed', data: { party: { id: 'x' } } })
  assert.equal(st.party, null)
})

// ---- roles: a scenario written for alice/bob can be played by any sessions ----
test('roles map scenario players to other sessions, in steps and in ${var} references', async () => {
  const h = harness(['dev1', 'dev2'])
  const ok = await runScenario({ id: 'r', name: 'r', sessions: ['alice', 'bob'], steps: [
    { as: 'alice', command: 'party/invite', data: { userId: '${bob.id}' } }
  ] }, h.ctx, { roles: { alice: 'dev1', bob: 'dev2' } })
  assert.equal(ok, true)
  assert.deepEqual(h.sent, [{ name: 'dev1', commandId: 'party/invite', data: { userId: '2' } }])
  // two roles on one session are refused, an offline mapped session aborts
  const dup = await runScenario({ id: 'r', name: 'r', sessions: ['alice', 'bob'], steps: [{ as: 'alice', command: 'a' }] }, h.ctx, { roles: { alice: 'dev1', bob: 'dev1' } })
  assert.equal(dup, false)
  assert.match(h.logs.at(-1).detail, /same session/)
})

test('a failed expectation says what the server actually answered', async () => {
  const h = harness()
  h.ctx.send = (name, { commandId }) => {
    setImmediate(() => h.emit({ dir: 'in', session: name, msg: { type: 'response', messageId: 'm0', commandId, status: 'failed', reason: 'party_in_matchmaking' } }))
    return 'm0'
  }
  const ok = await runScenario({ id: 'x', name: 'x', steps: [{ as: 'alice', command: 'party/invite', expect: { status: 'success' } }] }, h.ctx)
  assert.equal(ok, false)
  const fail = h.logs.find((l) => l.status === 'failed')
  assert.match(fail.detail, /got failed \(party_in_matchmaking\)/)
  assert.equal(fail.response.reason, 'party_in_matchmaking')
})

test('a timeout lists what the player received instead', async () => {
  const h = harness()
  const p = runScenario({ id: 'x', name: 'x', steps: [{ as: 'alice', waitFor: 'party/invited', timeout: 80 }] }, h.ctx)
  setTimeout(() => h.emit({ dir: 'in', session: 'alice', msg: { type: 'event', commandId: 'party/updated', messageId: 'e' } }), 20)
  assert.equal(await p, false)
  assert.match(h.logs.find((l) => l.status === 'failed').detail, /received instead: party\/updated/)
})

test('issue links are shown as project and number', () => {
  assert.equal(parseIssueUrl('https://github.com/beyond-all-reason/teiserver/issues/1475').label, 'teiserver #1475')
  assert.equal(parseIssueUrl('https://github.com/o/r/pull/9').kind, 'PR')
  assert.equal(parseIssueUrl('https://gitlab.com/g/proj/-/issues/7').label, 'proj #7')
  assert.equal(parseIssueUrl('https://x.atlassian.net/browse/BAR-42').label, 'BAR-42')
  assert.equal(parseIssueUrl('not a link'), null)
  assert.equal(parseIssueUrl('javascript:alert(1)'), null)
})
