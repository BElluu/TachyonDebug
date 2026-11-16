// OAuth2 authorization-code + PKCE flow (RFC 8252 loopback redirect) against a Tachyon server.
import http from 'node:http'
import crypto from 'node:crypto'

const b64url = (buf) => buf.toString('base64url')

async function metadata(base) {
  const res = await fetch(new URL('/.well-known/oauth-authorization-server', base))
  if (!res.ok) throw new Error(`oauth metadata: HTTP ${res.status} from ${base}`)
  return res.json()
}

async function tokenRequest(meta, params) {
  const res = await fetch(meta.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(params)
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok || !body.access_token) {
    throw new Error(`token endpoint: ${body.error_description ?? body.error ?? 'HTTP ' + res.status}`)
  }
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? params.refresh_token ?? null,
    expiresAt: body.expires_in ? Date.now() + body.expires_in * 1000 : null
  }
}

// Returns { authUrl, result } where `result` resolves with the tokens once the user
// has logged in in the browser (or rejects on error/timeout).
export async function startLogin({ base, clientId, timeoutMs = 300_000 }) {
  const meta = await metadata(base)
  const verifier = b64url(crypto.randomBytes(32))
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest())
  const state = b64url(crypto.randomBytes(16))

  let finish, fail
  const result = new Promise((res, rej) => ((finish = res), (fail = rej)))
  const srv = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    if (url.pathname !== '/oauth2callback') return res.writeHead(404).end()
    const done = (code, msg) => res.writeHead(code, { 'content-type': 'text/plain' }).end(msg)
    if (url.searchParams.get('state') !== state) return done(400, 'state mismatch')
    if (url.searchParams.get('error')) {
      done(400, `login failed: ${url.searchParams.get('error')}`)
      return fail(new Error(url.searchParams.get('error_description') ?? url.searchParams.get('error')))
    }
    try {
      const tokens = await tokenRequest(meta, {
        grant_type: 'authorization_code',
        code: url.searchParams.get('code'),
        redirect_uri: redirectUri,
        client_id: clientId,
        code_verifier: verifier
      })
      done(200, 'Logged in. You can close this tab and go back to TachyonDebug.')
      finish(tokens)
    } catch (err) {
      done(500, err.message)
      fail(err)
    }
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const redirectUri = `http://localhost:${srv.address().port}/oauth2callback`
  const timer = setTimeout(() => fail(new Error('login timed out')), timeoutMs)
  result.catch(() => {}).finally(() => { clearTimeout(timer); srv.close() })

  const auth = new URL(meta.authorization_endpoint)
  auth.search = new URLSearchParams({
    response_type: 'code', client_id: clientId, redirect_uri: redirectUri,
    scope: 'tachyon.lobby', state, code_challenge: challenge, code_challenge_method: 'S256'
  }).toString()
  return { authUrl: auth.toString(), result }
}

export async function refresh({ base, clientId, refreshToken }) {
  const meta = await metadata(base)
  return tokenRequest(meta, { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId })
}
