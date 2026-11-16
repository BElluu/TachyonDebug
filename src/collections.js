// Postman-style collections of saved requests, persisted in data/collections.json.
//   [{ id, name, requests: [{ id, name, as, commandId, data }] }]
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

const req = (name, commandId, data, as = null) => ({ id: randomUUID(), name, as, commandId, data })

function starter() {
  return [
    {
      id: randomUUID(),
      name: 'Party',
      requests: [
        req('Create party', 'party/create'),
        req('Invite bob', 'party/invite', { userId: '${bob.id}' }),
        req('Leave party', 'party/leave')
      ]
    },
    {
      id: randomUUID(),
      name: 'Matchmaking',
      requests: [req('List queues', 'matchmaking/list'), req('Cancel', 'matchmaking/cancel')]
    }
  ]
}

// Old flat toolbox ("folder/name" items) -> collections.
function migrate(items) {
  const byFolder = new Map()
  for (const t of items) {
    const i = t.name.indexOf('/')
    const folder = i > 0 ? t.name.slice(0, i) : 'Saved'
    if (!byFolder.has(folder)) byFolder.set(folder, [])
    byFolder.get(folder).push({ id: t.id ?? randomUUID(), name: i > 0 ? t.name.slice(i + 1) : t.name, as: t.as ?? null, commandId: t.commandId, data: t.data })
  }
  return [...byFolder].map(([name, requests]) => ({ id: randomUUID(), name, requests }))
}

export function loadCollections(dir) {
  const file = path.join(dir, 'collections.json')
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    /* none yet */
  }
  let initial
  try {
    const old = JSON.parse(fs.readFileSync(path.join(dir, 'toolbox.json'), 'utf8'))
    initial = old.length ? migrate(old) : starter()
  } catch {
    initial = starter()
  }
  saveCollections(dir, initial)
  return initial
}

export function saveCollections(dir, collections) {
  fs.writeFileSync(path.join(dir, 'collections.json'), JSON.stringify(collections, null, 2))
}
