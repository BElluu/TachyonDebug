import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { checkTeiserver, checkTachyon, detect, createSettings } from '../src/settings.js'
import { loadCollections } from '../src/collections.js'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tdbg-'))

test('checkTeiserver recognises a Teiserver checkout', () => {
  const d = tmp()
  assert.equal(checkTeiserver(path.join(d, 'nope')).ok, false)
  assert.match(checkTeiserver(d).message, /mix\.exs/)
  fs.writeFileSync(path.join(d, 'mix.exs'), 'defmodule Other.MixProject do\n  def project, do: [app: :other]\nend')
  assert.match(checkTeiserver(d).message, /not the Teiserver/)
  fs.writeFileSync(path.join(d, 'mix.exs'), 'defmodule Teiserver.MixProject do\n  def project, do: [app: :teiserver]\nend')
  assert.equal(checkTeiserver(d).ok, true)
})

test('checkTachyon needs a schema folder', () => {
  const d = tmp()
  assert.equal(checkTachyon(d).ok, false)
  fs.mkdirSync(path.join(d, 'schema'))
  assert.equal(checkTachyon(d).ok, true)
})

test('detect finds sibling checkouts', () => {
  const parent = tmp()
  const app = path.join(parent, 'TachyonDebug'); fs.mkdirSync(app)
  const t = path.join(parent, 'my-teiserver'); fs.mkdirSync(t)
  fs.writeFileSync(path.join(t, 'mix.exs'), 'app: :teiserver')
  const p = path.join(parent, 'proto'); fs.mkdirSync(path.join(p, 'schema'), { recursive: true })
  const found = detect(app)
  assert.ok(found.teiserver.includes(t))
  assert.ok(found.tachyon.includes(p))
})

test('settings persist and expand ~', () => {
  const data = tmp()
  const s = createSettings(data, '/x/TachyonDebug')
  assert.equal(s.get().setupDone, false)
  assert.equal(s.get().teiserverDir, path.resolve('/x/teiserver'))
  s.save({ setupDone: true, teiserverDir: '~/some/where' })
  assert.equal(createSettings(data, '/x/TachyonDebug').get().teiserverDir, path.join(os.homedir(), 'some/where'))
})

test('collections: starter set, then migration of the old flat toolbox', () => {
  const fresh = tmp()
  assert.ok(loadCollections(fresh).some((c) => c.name === 'Party'))
  const old = tmp()
  fs.writeFileSync(path.join(old, 'toolbox.json'), JSON.stringify([
    { id: '1', name: 'party/invite bob', as: 'alice', commandId: 'party/invite', data: { userId: '2' } },
    { id: '2', name: 'loose', commandId: 'matchmaking/list' }
  ]))
  const cols = loadCollections(old)
  assert.deepEqual(cols.map((c) => c.name).sort(), ['Saved', 'party'])
  assert.equal(cols.find((c) => c.name === 'party').requests[0].name, 'invite bob')
  assert.ok(fs.existsSync(path.join(old, 'collections.json')))
})
