#!/usr/bin/env node
// Headless scenario runner for CI / quick checks:
//   npm run scenarios -- [options]
//
//   --filter <text>      only scenarios whose name/category contains the text
//   --category <name>    only this category (repeatable, comma separated)
//   --id <id,id>         exact scenario ids (e.g. builtin:party-kick.json)
//   --schema <mode>      off | warn (default) | fail: how to treat responses that break the protocol schema
//   --repeat <n>         run the selection n times (finds races)
//   --stop-on-fail       stop at the first failing scenario
//   --junit <file>       also write a JUnit XML report
//   --json               print the result as JSON instead of text
//   --port <n>           helper port (default 2137)
//   --map <a=x,b=y>      play the roles a and b of the scenarios with the sessions x and y (default: same names)
//   --list               just list the scenarios
//
// If no helper is running it starts one in this process. The players the scenarios need must exist
// (create them once in the UI); they are connected automatically. Exit code: 0 all passed, 1 a failure, 2 setup problem.
import fs from 'node:fs'
import { WebSocket } from 'ws'

const argv = process.argv.slice(2)
const opt = (name, d) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? (argv[i + 1] === undefined || argv[i + 1].startsWith('--') ? true : argv[i + 1]) : d }
const flag = (name) => argv.includes(`--${name}`)
const PORT = Number(opt('port', process.env.PORT ?? 2137))
const asJson = flag('json')
const say = (...a) => { if (!asJson) console.log(...a) }
const die = (msg, code = 2) => { console.error(msg); process.exit(code) }

if (flag('help') || flag('h')) {
  console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 19).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'))
  process.exit(0)
}

const open = () => new Promise((resolve, reject) => {
  const sock = new WebSocket(`ws://127.0.0.1:${PORT}/ui`)
  const t = setTimeout(() => { sock.terminate(); reject(new Error('timeout')) }, 3000)
  sock.once('open', () => { clearTimeout(t); resolve(sock) })
  sock.once('error', (e) => { clearTimeout(t); reject(e) })
})

let ws
try { ws = await open() } catch {
  say(`no helper on port ${PORT}, starting one…`)
  process.env.PORT = String(PORT)
  await import('./server.js')
  try { ws = await open() } catch (e) { die(`cannot reach the helper: ${e.message}`) }
}

let init = null
const waiters = []
const listeners = new Set()
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString())
  if (m.op === 'init') init = m
  if (m.op === 'session' && init) init.sessions = [...init.sessions.filter((s) => s.name !== m.session.name), m.session]
  if (m.op === 'sessionRemoved' && init) init.sessions = init.sessions.filter((s) => s.name !== m.name)
  listeners.forEach((fn) => fn(m))
  for (const w of [...waiters]) if (w.test(m)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m) }
})
const until = (test, ms, what) => new Promise((resolve, reject) => {
  const w = { test, resolve }
  waiters.push(w)
  setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) { waiters.splice(i, 1); reject(new Error(`timeout waiting for ${what}`)) } }, ms).unref()
})
const send = (p) => ws.send(JSON.stringify(p))

if (!init) await until((m) => m.op === 'init', 5000, 'the helper state').catch((e) => die(e.message))

// ---- choose scenarios --------------------------------------------------------------------
const split = (v) => (typeof v === 'string' ? v.split(',').map((x) => x.trim()).filter(Boolean) : [])
let chosen = init.scenarios.filter((s) => !s.broken)
if (opt('id')) chosen = chosen.filter((s) => split(opt('id')).includes(s.id))
if (opt('category')) chosen = chosen.filter((s) => split(opt('category')).some((c) => c.toLowerCase() === s.category.toLowerCase()))
if (typeof opt('filter') === 'string') chosen = chosen.filter((s) => `${s.name} ${s.category}`.toLowerCase().includes(opt('filter').toLowerCase()))
if (flag('list')) {
  for (const s of chosen) console.log(`${s.id.padEnd(48)} ${s.category.padEnd(12)} ${s.name}`)
  process.exit(0)
}
if (!chosen.length) die('no scenarios match')

// ---- make sure the players exist and are connected -----------------------------------------
const map = Object.fromEntries(split(opt('map')).map((p) => p.split('=').map((x) => x.trim())))
const have = (n) => init.sessions.find((s) => s.name === n)
const rolesOf = (sc) => Object.fromEntries(sc.sessions.map((r) => [r, map[r] ?? r]))
// a scenario whose players are not there is skipped, like "Run all" in the UI does
const runnable = chosen.filter((sc) => Object.values(rolesOf(sc)).every(have))
for (const sc of chosen.filter((x) => !runnable.includes(x))) say(`- skipped ${sc.name}: no player for ${sc.sessions.filter((r) => !have(map[r] ?? r)).join(', ')}`)
if (!runnable.length) die('no scenario has all its players. Create them in the UI (Players → Add player), or map roles with --map player1=dev1,player2=dev2.')
chosen = runnable
const roles = Object.fromEntries(chosen.map((sc) => [sc.id, rolesOf(sc)]))
const need = [...new Set(chosen.flatMap((sc) => Object.values(rolesOf(sc))))]
for (const n of need.filter((n) => have(n).state !== 'open')) {
  say(`connecting ${n}…`)
  send({ op: 'connect', name: n })
  await until((m) => m.op === 'session' && m.session.name === n && m.session.state === 'open', 120000, `${n} to connect`).catch((e) => die(e.message))
}
// scenarios use ${name.id}: wait until user/self told us the ids
await new Promise((r) => setTimeout(r, 400))

// ---- run ------------------------------------------------------------------------------------
const stepInfo = new Map() // scenario id -> failed step text
listeners.add((m) => {
  if (m.op === 'scenarioLog' && m.status === 'failed') stepInfo.set(m.scenario, `step ${m.step + 1}: ${m.detail}`)
  if (m.op === 'scenarioLog' && m.schemaIssues?.length) say(`    ~ schema: ${m.scenario} step ${m.step + 1}: ${m.schemaIssues.map((i) => `${i.path} ${i.message}`).join('; ')}`)
  if (m.op === 'scenarioBatch' && m.status === 'progress') {
    const r = m.last
    say(`${r.ok ? '✓' : '✗'} ${r.name}${r.round > 1 ? ` (round ${r.round})` : ''}  ${r.ms} ms${r.ok ? '' : `\n    ${stepInfo.get(r.id) ?? r.detail ?? ''}`}`)
  }
})
const schema = ['off', 'warn', 'fail'].includes(opt('schema')) ? opt('schema') : 'warn'
send({ op: 'runScenarios', ids: chosen.map((s) => s.id), roles, schema, repeat: Number(opt('repeat', 1)), stopOnFail: flag('stop-on-fail') })
const done = await until((m) => m.op === 'scenarioBatch' && m.status === 'done', 60 * 60 * 1000, 'the run to finish').catch((e) => die(e.message))

// ---- report ----------------------------------------------------------------------------------
const esc = (t) => String(t ?? '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c])
if (typeof opt('junit') === 'string') {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="tachyon-scenarios" tests="${done.results.length}" failures="${done.failed}" time="${(done.ms / 1000).toFixed(3)}">\n` +
    done.results.map((r) => `  <testcase classname="${esc(r.id)}" name="${esc(r.name)}" time="${(r.ms / 1000).toFixed(3)}">${r.ok ? '' : `<failure message="${esc(stepInfo.get(r.id) ?? r.detail)}"/>`}</testcase>`).join('\n') + '\n</testsuite>\n'
  fs.writeFileSync(opt('junit'), xml)
}
if (asJson) console.log(JSON.stringify({ passed: done.passed, failed: done.failed, ms: done.ms, results: done.results.map((r) => ({ ...r, detail: stepInfo.get(r.id) ?? r.detail })) }, null, 2))
else console.log(`\n${done.passed} passed, ${done.failed} failed in ${(done.ms / 1000).toFixed(1)} s`)
process.exit(done.failed ? 1 : 0)
