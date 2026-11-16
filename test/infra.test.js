import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createLocalServer, isUp } from '../src/localServer.js'
import { startLogin, refresh } from '../src/oauth.js'

const listen = (handler) => new Promise((r) => { const s = http.createServer(handler); s.listen(0, '127.0.0.1', () => r(s)) })

test('local server: starts it when down, reports up, stops it', async () => {
  const probe = await listen(() => {}); const port = probe.address().port; probe.close()
  const events = []
  const local = createLocalServer({
    dir: process.cwd(), httpUrl: `http://127.0.0.1:${port}/`, startTimeoutMs: 10_000,
    onChange: (e) => events.push(e.status), onLog: () => {},
    commands: {
      pg: null,
      server: [process.execPath, ['-e', `setTimeout(()=>require('http').createServer((q,r)=>r.end('hi')).listen(${port},'127.0.0.1'),600)`]]
    }
  })
  assert.equal(await local.refresh(), 'down')
  await Promise.all([local.ensureUp(), local.ensureUp()]) // concurrent calls share one start
  assert.equal(local.status, 'up')
  assert.ok(local.managed)
  assert.equal(await isUp(`http://127.0.0.1:${port}/`), true)
  await local.stop()
  assert.equal(local.status, 'down')
  assert.equal(await isUp(`http://127.0.0.1:${port}/`), false)
  assert.deepEqual(events.filter((e, i) => e !== events[i - 1]), ['down', 'starting', 'up', 'stopping', 'down'])
})

test('local server: refuses to stop a server it did not start', async () => {
  const local = createLocalServer({ dir: '.', httpUrl: 'http://127.0.0.1:1/', onChange() {}, onLog() {} })
  await assert.rejects(local.stop(), /refusing/)
})

test('oauth: PKCE login via loopback and refresh', async () => {
  const seen = {}
  const idp = await listen(async (req, res) => {
    const base = `http://127.0.0.1:${idp.address().port}`
    if (req.url.startsWith('/.well-known')) {
      return res.end(JSON.stringify({ authorization_endpoint: `${base}/oauth/authorize`, token_endpoint: `${base}/oauth/token` }))
    }
    let body = ''
    for await (const c of req) body += c
    seen[new URLSearchParams(body).get('grant_type')] = new URLSearchParams(body)
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ access_token: 'AT', refresh_token: 'RT', expires_in: 3600 }))
  })
  const base = `http://127.0.0.1:${idp.address().port}`
  const { authUrl, result } = await startLogin({ base, clientId: 'generic_lobby' })
  const u = new URL(authUrl)
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(u.searchParams.get('scope'), 'tachyon.lobby')
  // pretend the browser got redirected back with a code
  const cb = new URL(u.searchParams.get('redirect_uri'))
  cb.search = new URLSearchParams({ code: 'CODE', state: u.searchParams.get('state') })
  assert.equal((await fetch(cb)).status, 200)
  const tokens = await result
  assert.equal(tokens.accessToken, 'AT')
  assert.equal(seen.authorization_code.get('code'), 'CODE')
  assert.ok(seen.authorization_code.get('code_verifier'))

  const t2 = await refresh({ base, clientId: 'generic_lobby', refreshToken: 'RT' })
  assert.equal(t2.accessToken, 'AT')
  assert.equal(seen.refresh_token.get('refresh_token'), 'RT')
  idp.close()
})

test('local server: force stop kills an external server by port', async () => {
  const { spawn } = await import('node:child_process')
  const probe = await listen(() => {}); const port = probe.address().port; probe.close()
  const ext = spawn(process.execPath, ['-e', `require('http').createServer((q,r)=>r.end('x')).listen(${port},'127.0.0.1')`])
  const url = `http://127.0.0.1:${port}/`
  for (let i = 0; i < 40 && !(await isUp(url)); i++) await new Promise((r) => setTimeout(r, 100))
  const local = createLocalServer({ dir: '.', httpUrl: url, onChange() {}, onLog() {} })
  await assert.rejects(local.stop(), /refusing/)
  await local.stop({ force: true })
  assert.equal(local.status, 'down')
  assert.equal(await isUp(url), false)
  ext.kill()
})
