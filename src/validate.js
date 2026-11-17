// Validates Tachyon messages against the JSON schemas of the protocol repo.
// The schemas are draft-07 with every $ref already inlined by catalog.js, so each message kind is one self-contained schema.
import Ajv from 'ajv'
import addFormats from 'ajv-formats'

export function createValidator(full) {
  const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: true })
  addFormats(ajv)
  const compiled = new Map()
  const get = (key) => {
    if (compiled.has(key)) return compiled.get(key)
    let fn = null
    const schema = full?.get(key)
    if (schema) {
      try { fn = ajv.compile(schema) } catch { fn = null }
    }
    compiled.set(key, fn)
    return fn
  }
  const issue = (e) => ({
    path: e.instancePath ? e.instancePath.slice(1).split('/').join('.') : '(root)',
    message: e.keyword === 'additionalProperties' ? `unexpected property "${e.params.additionalProperty}"`
      : e.keyword === 'required' ? `missing required property "${e.params.missingProperty}"`
      : e.keyword === 'enum' ? `must be one of: ${e.params.allowedValues.join(', ')}`
      : e.message
  })

  return {
    /** kind: 'request' | 'response' | 'event'. Returns { known, issues }. */
    validate(msg, kind) {
      const commandId = msg?.commandId
      if (typeof commandId !== 'string') return { known: false, issues: [] }
      const fn = get(`${commandId}|${kind}`)
      if (!fn) return { known: false, issues: [] }
      if (fn(msg)) return { known: true, issues: [] }
      // anyOf failures bury the useful errors; keep the deepest/most specific ones, drop the noise
      const errs = (fn.errors ?? []).filter((e) => e.keyword !== 'anyOf' && e.keyword !== 'oneOf' && e.keyword !== 'if')
      const seen = new Set()
      const issues = (errs.length ? errs : fn.errors ?? []).map(issue).filter((i) => { const k = `${i.path}|${i.message}`; return !seen.has(k) && seen.add(k) })
      return { known: true, issues: issues.slice(0, 12) }
    },
    /** Only the `data` part of a request typed in the editor (the envelope is added for you). */
    validateRequestData(commandId, data) {
      return this.validate({ type: 'request', messageId: 'x', commandId, ...(data === undefined ? {} : { data }) }, 'request')
    }
  }
}
