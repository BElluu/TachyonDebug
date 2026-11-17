// Builds a catalog of Tachyon commands from the JSON schemas of the protocol repo.
import fs from 'node:fs'
import path from 'node:path'

const KINDS = ['request', 'response', 'event']

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

// Resolve relative file $refs (the protocol schemas only use those).
function deref(node, file, depth = 0) {
  if (depth > 40 || node === null || typeof node !== 'object') return node
  if (Array.isArray(node)) return node.map((n) => deref(n, file, depth + 1))
  if (typeof node.$ref === 'string' && !node.$ref.startsWith('#')) {
    const target = path.resolve(path.dirname(file), node.$ref)
    try {
      return deref(readJson(target), target, depth + 1)
    } catch {
      return {}
    }
  }
  const out = {}
  for (const [k, v] of Object.entries(node)) out[k] = deref(v, file, depth + 1)
  return out
}

// A copy without $id/$schema: inlined $refs would otherwise bring duplicate ids into one validator.
export function stripIds(node) {
  if (Array.isArray(node)) return node.map(stripIds)
  if (!node || typeof node !== 'object') return node
  const out = {}
  for (const [k, v] of Object.entries(node)) if (k !== '$id' && k !== '$schema') out[k] = stripIds(v)
  return out
}

// Flat description of the top-level fields of an object schema, for the editor's help panel.
export function fieldsOf(schema) {
  const branches = schema?.anyOf ?? schema?.oneOf ?? [schema]
  const out = new Map()
  for (const b of branches) {
    const req = new Set(b?.required ?? [])
    for (const [name, v] of Object.entries(b?.properties ?? {})) {
      if (out.has(name)) continue
      let type = v.type
      if (Array.isArray(type)) type = type.join('|')
      if (!type && v.enum) type = 'enum'
      if (!type && (v.anyOf || v.oneOf)) type = 'one of'
      out.set(name, {
        name, type: type ?? 'any', required: req.has(name),
        description: v.description ?? v.title ?? '',
        enum: Array.isArray(v.enum) ? v.enum : v.const !== undefined ? [v.const] : undefined,
        format: v.format
      })
    }
  }
  return [...out.values()]
}

// Produce an example value for a (dereferenced) schema.
export function sample(schema, all = false) {
  if (!schema || typeof schema !== 'object') return null
  if ('const' in schema) return schema.const
  if (Array.isArray(schema.examples) && schema.examples.length) return schema.examples[0]
  if ('default' in schema) return schema.default
  if (Array.isArray(schema.enum)) return schema.enum[0]
  if (schema.anyOf || schema.oneOf) return sample((schema.anyOf || schema.oneOf)[0], all)
  if (schema.allOf) return Object.assign({}, ...schema.allOf.map((x) => sample(x, all)))
  let type = schema.type
  if (Array.isArray(type)) type = type.find((t) => t !== 'null') ?? type[0]
  if (!type && schema.properties) type = 'object'
  switch (type) {
    case 'object': {
      const obj = {}
      const required = new Set(schema.required ?? [])
      for (const [k, v] of Object.entries(schema.properties ?? {})) {
        if (all || required.has(k) || (v && typeof v === 'object' && 'default' in v)) obj[k] = sample(v, all)
      }
      return obj
    }
    case 'array':
      return schema.items ? [sample(schema.items, all)] : []
    case 'string':
      return ''
    case 'integer':
    case 'number':
      return schema.minimum ?? 0
    case 'boolean':
      return false
    default:
      return null
  }
}

// Pull the `data` sub-schema out of a message schema, whatever shape it has.
function dataSchema(schema) {
  const branches = schema.anyOf ?? schema.oneOf ?? [schema]
  for (const b of branches) {
    if (b.properties?.data) return b.properties.data
  }
  return null
}

export function buildCatalog(schemaDir) {
  const commands = {}
  const full = new Map() // `${id}|${kind}` -> whole-message schema (server side only, never sent to the UI)
  if (!fs.existsSync(schemaDir)) return { commands: [], error: `schema dir not found: ${schemaDir}` }

  for (const group of fs.readdirSync(schemaDir)) {
    if (group === 'definitions') continue
    const groupDir = path.join(schemaDir, group)
    if (!fs.statSync(groupDir).isDirectory()) continue
    for (const cmd of fs.readdirSync(groupDir)) {
      for (const kind of KINDS) {
        const file = path.join(groupDir, cmd, `${kind}.json`)
        if (!fs.existsSync(file)) continue
        const schema = deref(readJson(file), file)
        const id = `${group}/${cmd}`
        const entry = (commands[id] ??= { id, group, name: cmd, kinds: {} })
        const ds = dataSchema(schema)
        full.set(`${id}|${kind}`, stripIds(schema))
        entry.kinds[kind] = {
          source: schema.tachyon?.source,
          scopes: schema.tachyon?.scopes ?? [],
          // the response schema doubles as documentation of the failure reasons
          template: ds ? sample(ds) : undefined,
          fullTemplate: ds ? sample(ds, true) : undefined,
          fields: ds ? fieldsOf(ds) : undefined,
          schema: ds ?? undefined,
          examples: ds?.examples,
          reasons: kind === 'response' ? failReasons(schema) : undefined
        }
      }
    }
  }
  const list = Object.values(commands).sort((a, b) => a.id.localeCompare(b.id))
  const result = { commands: list }
  Object.defineProperty(result, 'full', { value: full, enumerable: false })
  return result
}

function failReasons(schema) {
  const branches = schema.anyOf ?? [schema]
  for (const b of branches) {
    const reason = b.properties?.reason
    if (reason?.enum) return reason.enum
  }
  return undefined
}
