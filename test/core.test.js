import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import fs from 'node:fs'
import { buildCatalog } from '../src/catalog.js'
import { subst, matches, getPath, runScenario, listScenarios } from '../src/scenarios.js'

const schemaDir = path.resolve(process.env.TACHYON_DIR ?? '../tachyon', 'schema')

test('catalog is built from the protocol schemas', { skip: !fs.existsSync(schemaDir) }, () => {
  const { commands } = buildCatalog(schemaDir)
  const invite = commands.find((c) => c.id === 'party/invite')
  assert.deepEqual(invite.kinds.request.template, { userId: '351' })
  const queue = commands.find((c) => c.id === 'matchmaking/queue')
  assert.ok(queue.kinds.response.reasons.includes('already_queued'))
  assert.equal(commands.find((c) => c.id === 'matchmaking/cancelled').kinds.event.source, 'server')
})

test('getPath supports field=value selectors', () => {
  const obj = { data: { playlists: [{ teamSize: 1, id: 'a' }, { teamSize: 2, id: 'b' }] } }
  assert.equal(getPath(obj, 'data.playlists.teamSize=2').id, 'b')
  assert.equal(getPath(obj, 'data.playlists.0.id'), 'a')
})

test('subst resolves session users and captured vars', () => {
  const sessions = new Map([['bob', { user: { id: '7', name: 'Bob' } }]])
  const vars = new Map([['party', { id: 'p1' }]])
  assert.deepEqual(subst({ a: ['${bob.id}', '${party.id}'] }, sessions, vars), { a: ['7', 'p1'] })
  assert.throws(() => subst('${carol.id}', sessions, vars))
})

test('matches does subset matching', () => {
  assert.ok(matches({ a: 1, b: { c: 2 } }, { b: { c: 2 } }))
  assert.ok(!matches({ a: 1 }, { a: 2 }))
})

test('runScenario drives requests, waits for events and stops on mismatch', async () => {
  const listeners = new Set()
  const sessions = new Map([['alice', { state: 'open', user: { id: '1' } }], ['bob', { state: 'open', user: { id: '2' } }]])
  const emit = (e) => [...listeners].forEach((fn) => fn(e))
  let n = 0
  const send = (name, { commandId }) => {
    const messageId = `m${++n}`
    setImmediate(() => {
      emit({ dir: 'in', session: name, msg: { type: 'response', messageId, commandId, status: commandId === 'bad' ? 'failed' : 'success' } })
      if (commandId === 'party/invite') emit({ dir: 'in', session: 'bob', msg: { type: 'event', commandId: 'party/invited', data: { party: { id: 'P' } } } })
    })
    return messageId
  }
  const logs = []
  const ctx = { sessions, send, onLog: (l) => logs.push(l), listen: (fn) => (listeners.add(fn), () => listeners.delete(fn)) }

  const ok = await runScenario({ file: 'x', name: 'x', steps: [
    { as: 'alice', command: 'party/invite', data: { userId: '${bob.id}' }, expect: { status: 'success' } },
    { as: 'bob', waitFor: 'party/invited', capture: { party: 'data.party' } }
  ] }, ctx)
  assert.equal(ok, true)

  const bad = await runScenario({ file: 'y', name: 'y', steps: [{ as: 'alice', command: 'bad', expect: { status: 'success' } }] }, ctx)
  assert.equal(bad, false)
  assert.equal(logs.at(-1).status, 'aborted')
})
