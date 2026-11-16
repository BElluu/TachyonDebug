# TachyonDebug

Local web UI for poking a Teiserver **Tachyon** server with several clients at once.

- Many named sessions (alice, bob, …), each with its own token and WebSocket.
- Command picker generated from the protocol schemas (`../tachyon/schema`), with a
  ready-to-edit JSON template and the list of failure reasons.
- One timeline with every message from every session (filter, columns per session,
  resend/edit, responses labelled with their command).
- Scenarios: scripted multi-client flows (`scenarios/*.json`) with assertions.
- Token generation via `mix teiserver.gen_token` from the UI.

## Run

```bash
npm install
npm start            # http://localhost:4747
npm test
```

Env vars: `PORT` (4747), `TACHYON_DIR` (`../tachyon`), `TEISERVER_DIR` (`../teiserver`),
`TACHYON_URL` (`ws://localhost:4000/tachyon`).

## Environments

| env   | url                                                  | token                                   |
|-------|------------------------------------------------------|-----------------------------------------|
| local | `ws://localhost:4000/tachyon` (a `../teiserver` checkout) | **generate token** (`mix teiserver.gen_token`) |
| dev   | `wss://lobby-server-dev.beyondallreason.dev/tachyon` | **log in via browser** (OAuth + PKCE), or paste one |

- **Local autostart**: connecting a `local` session when nothing listens on port 4000 starts
  Postgres (`mise run pg:start`) and `mix phx.server` in `TEISERVER_DIR`, streams its log in the
  *Local Teiserver* panel and waits until it answers. The *start*/*stop* buttons do the same by hand.
  *stop* only works on a server TachyonDebug started itself, and it is stopped when TachyonDebug exits.
  A server you started yourself is detected and left alone.
- **Dev login**: opens the dev server's `/oauth/authorize` in a browser tab and catches the redirect on
  a loopback port (client id `generic_lobby`, override with `TACHYON_CLIENT_ID`). The refresh token is
  kept in `data/sessions.json` and used to renew the access token on reconnect.
  The dev server must accept that client and loopback redirect URIs.

Extra env vars: `TACHYON_DEV_URL` (default `https://lobby-server-dev.beyondallreason.dev`).

## Use

1. For `local`, run `mix teiserver.tachyon_setup` once in Teiserver (the server itself starts on demand).
2. In the UI: *add session*, pick the environment, get a token (see above), **connect**.
   For `local` the name must be the Teiserver username. Sessions (incl. tokens) are saved in
   `data/sessions.json` (git-ignored).
3. Pick a command on the right, edit the JSON, **Ctrl+Enter** to send. `/` focuses the search.

## Scenarios

```json
{ "name": "...", "description": "...", "sessions": ["alice", "bob"],
  "steps": [
    { "as": "alice", "command": "party/invite", "data": { "userId": "${bob.id}" }, "expect": { "status": "success" } },
    { "as": "bob", "waitFor": "party/invited", "capture": { "party": "data.party" } },
    { "as": "bob", "command": "party/acceptInvite", "data": { "partyId": "${party.id}" } },
    { "sleep": 200 }
  ] }
```

- `${session.id}` / `${session.name}`: user learned from the `user/self` event on connect.
- `capture` stores a value from the response/event; path segments are keys, indexes or
  `field=value` to pick an array element. Use it as `${var.path}`.
- `expect` is a subset match. Events arriving before their `waitFor` step are buffered.
- 5s timeout per step; the run aborts on the first failure.

`scenarios/party-cancel-matchmaking.json` reproduces issue #1475.
