# TachyonDebug

A launcher-style workbench for poking a Teiserver **Tachyon** server with several players at once.

```bash
npm install
npm start          # http://localhost:4747  (first run opens a setup wizard)
npm test
```

## What you get

- **Setup wizard** on first run: finds your Teiserver and Tachyon-protocol checkouts, validates them,
  sets up the servers and your first players. Everything stays editable in **Settings**
  (`data/settings.json`).
- **Players** (top bar): one click creates sessions. *Local*: pick users that already exist in your
  local Teiserver (read from its dev database) and give each a session name such as `alice` (scenarios
  and saved requests use `alice`, `bob`, `carol`). The helper starts Teiserver if needed, generates a
  token for each user (`mix teiserver.gen_token`), and renews it by itself when it expires.
  *Dev* (`lobby-server-dev.beyondallreason.dev`): browser login (OAuth + PKCE), the refresh token is
  kept so you log in once. Pasting a token by hand is under *I already have a token*.
- **Collections** (sidebar), Postman style: folders of saved requests, drag to move, search, history.
  Each request opens in a tab; `Ctrl+Enter` sends, `Ctrl+S` saves, `/` jumps to the command box.
  `${bob.id}` in a body is replaced with the user id of the connected player `bob`.
- **Response pane** with status, failure reason and latency, and a **Timeline** with every message of
  every player (filters, per-player columns, resend, save as request).
- **Scenarios** (`scenarios/*.json`): scripted multi-player flows with assertions, see below.
- **Status bar**: local server state with Start/Stop (it can also stop a server you started yourself,
  after asking) and dev-server reachability. The log of a server started from here is under *Log*.

The command list and the JSON templates come from the protocol repo's `schema/` folder.

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

- `${player.id}` / `${player.name}`: user learned from the `user/self` event on connect.
- `capture` stores a value from the response/event. Path segments are keys, indexes, or `field=value`
  to pick an array element. Use it as `${var.path}`.
- `expect` is a subset match. Events arriving before their `waitFor` step are buffered.
- 5 s timeout per step, the run aborts on the first failure.

`scenarios/party-cancel-matchmaking.json` reproduces Teiserver issue #1475.

## Configuration

Defaults come from env vars and are then stored by the wizard: `PORT` (4747), `TEISERVER_DIR`,
`TACHYON_DIR`, `TACHYON_URL`, `TACHYON_DEV_URL`, `TACHYON_CLIENT_ID`, and `TACHYON_DEBUG_DATA`
(where `data/` lives). Tokens never reach the browser; they stay in the helper process and in
`data/sessions.json` (git-ignored).
