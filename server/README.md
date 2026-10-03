# Rare City server

One Node/TypeScript service and PostgreSQL, in the same repository as the client. It holds
the shared city, serves it to everyone, and knows who is looking. It reuses the
deterministic rules in `src/game` and `src/config` and the wire contracts in `src/protocol`
rather than reimplementing them.

What it does today:

- holds **one authoritative city** in Postgres, with a sequence that orders its changes;
- serves that city to anyone at `GET /v1/city`, signed in or not;
- lets a visitor **sign in with an EVM wallet** by signing a one-time challenge, and keeps
  a server session for them;
- reads, from Robinhood Chain, **which Rare Friends the signed-in wallet owns** and each
  one's canonical family;
- serves the built Rare City client from the same origin, when a client build is present;
- when `ACTIVATION_ENABLED=true`, and only then, lets the signed-in owner of a Rare Friend
  **activate it as a permanent property** on one exact plot, by signing a message.

Activation is the **only way the city changes**, it is off by default, and no deployment has
it on. There is no gameplay command, no RF read or movement, and no transaction of any
kind: activating a Friend is a signature, and nothing here signs or sends anything to a
chain. No screen activates anything yet (the client for it is a later slice). The live demo
at rarecity.world does not use this service.

See "Activation foundation" for the tables and guards (migration `0004`) and "Permanent
Friend activation" for the server path that writes them.

## Layout

```
server/
  src/
    main.ts            process entry: config, pool, client build, HTTP server, shutdown
    app.ts             HTTP routes
    http.ts            bounded JSON bodies, the session cookie, the same-origin rule
    clientKey.ts       which network a request came from, under the configured proxy trust
    rateLimit.ts       in-memory request limits, and the limits of today's routes
    securityHeaders.ts HSTS, Content-Security-Policy, framing and the other response headers
    static.ts          same-origin client: a fixed list of files loaded at start-up
    config.ts          environment → validated ServerConfig
    log.ts             JSON-lines logger
    engine.ts          the only doorway into src/game, src/config and src/protocol
    city/store.ts      the city: read side, and the one way a city is installed
    city/genesis.ts    operator-only: canonical genesis, rehearsal genesis, the guarded staging reset
    city/verify.ts     read-only check of the installed city against every invariant
    auth/service.ts    sign-in challenges, signature verification, sessions
    activation/service.ts     permanent Friend activation: issue an intent, commit it
    activation/typedData.ts   the EIP-712 PropertyActivation message and its hash
    activation/propertyId.ts  deterministic property and ownership-era ids
    activation/properties.ts  which Friends have a property (the My Friends annotation)
    ownership/provider.ts     the OwnershipProvider interface
    ownership/generations.ts  Rare Friends on Robinhood Chain (the real adapter)
    ownership/fixture.ts      deterministic stand-in for local work and tests
    ownership/reader.ts       short-lived cache for the "My Friends" view
    fixtures/demoCity.ts   NON-CANONICAL demo city for staging and tests
    migrate-cli.ts     `npm run db:migrate`
    seed-demo-cli.ts   `npm run city:seed-demo -- --non-canonical`
    genesis-cli.ts     `npm run city:genesis -- <command>`
    verify-cli.ts      `npm run city:verify`
    db/pool.ts         pg pool
    db/transaction.ts  one transaction on one pooled connection, and when that connection may be reused
    db/migrations.ts   migration loader, runner and readiness probe
  migrations/          plain SQL, NNNN_snake_case_name.sql
  tests/
e2e-server/            browser tests of the built app against a real Postgres
```

## Endpoints

| Route | Meaning |
| --- | --- |
| `GET /health` | Liveness. Always `200 {"status":"ok"}` while the process is up. Never touches the database. |
| `GET /ready` | Readiness. `200` when the database is reachable, fully migrated and stamped for this `APP_MODE`; otherwise `503` with the failing check. In local mode with no `DATABASE_URL` it is `200` with `"database":"not-configured"`. It does not depend on a city being installed. |
| `GET /version` | Service name, `APP_MODE` and the deployed commit. |
| `GET /v1/city` | The authoritative city. See below. |
| `GET /v1/viewer` | Who this browser is signed in as, or `{"authenticated":false}`. |
| `GET /v1/viewer/friends` | The Rare Friends the signed-in wallet owns. `401` when not signed in. |
| `POST /v1/auth/challenge` | Ask for a sign-in message for an address. |
| `POST /v1/auth/verify` | Present the signature; opens a session and sets the cookie. |
| `POST /v1/auth/logout` | Revoke the session and expire the cookie. |
| `POST /v1/activation/intents` | Ask for the message that would activate one owned Friend on one plot. `403 activation_disabled` unless `ACTIVATION_ENABLED=true`. |
| `POST /v1/activations` | Present the wallet's signature of that message; activates the Friend. `403 activation_disabled` unless `ACTIVATION_ENABLED=true`. |
| anything else | With a client build: the file at that path, or the app shell for a client route. Without one: `404`. |

`/health`, `/ready`, `/version` and everything under `/v1` belong to the service: an unknown
path there is a JSON `404` and is never answered with the app shell. A path whose last
segment has an extension and matches no file is a `404`, not the app shell. The three
`/v1/auth` routes and the two activation routes accept only `POST` (`405`, `Allow: POST`);
every other path accepts only `GET`/`HEAD` (`405`, `Allow: GET, HEAD`).

Five routes are rate limited (see "Edge" below) and answer `429 {"error":"rate_limited"}`
with `Retry-After` when a client or user is over its limit.

### `GET /v1/city`

```
200
ETag: "<instance>.<sequence>"
Cache-Control: no-cache

{
  "city": {
    "id": "main",
    "instance": "<uuid>",          // this installation of the city
    "sequence": 1,                 // +1 with every authoritative change
    "stateVersion": 5,             // version of the GameState shape
    "canonical": false,            // false = non-canonical staging/test state
    "origin": "demo-fixture",      // "genesis" | "demo-fixture"
    "updatedAt": "2026-10-02T00:00:00.000Z"
  },
  "server": { "mode": "staging" },
  "state": { ...GameState }
}
```

- `If-None-Match` with the current ETag returns `304`. Responses are gzip-compressed on request.
- The body is the same bytes for every caller and never says who is looking. Until P0-C it
  carried a `viewer` key; that is gone (identity is `GET /v1/viewer`). The client's parser
  ignores the key if an older server sends it and never takes an identity from it.
- A session cookie has no effect on this route, and it never sets one.
- Errors are `503 {"error": <code>}` with `Retry-After: 5`:
  `city_not_initialized` (no city installed), `city_state_unsupported` (stored state has
  another `stateVersion`), `city_state_invalid` (stored state failed validation; none of it
  is served), `city_unavailable` (no database, or it failed).
- There is no events endpoint. The client needs the whole snapshot and revalidates it by ETag.

## Identity

Identity is separate from the city on purpose. The city is one shared, cacheable document;
who is looking is worked out per request from the session cookie and is never cached
(`Cache-Control: no-store`, `Vary: Cookie`). Signing in or out changes `/v1/viewer`
immediately and never touches the city or its sequence.

A signed-in wallet can do one thing in the city, and only where `ACTIVATION_ENABLED=true`:
activate a Friend it owns (see "Permanent Friend activation"). A session alone never
authorises that. The client has no screen for it yet and keeps treating the city as
read-only for everyone.

### Signing in

[EIP-4361](https://eips.ethereum.org/EIPS/eip-4361) (Sign-In with Ethereum) messages, signed
with `personal_sign`. Signature recovery and message construction are viem's; the service
implements no cryptography.

1. `POST /v1/auth/challenge` with `{"address": "0x…", "chainId": 4663}`. The service writes
   the message, stores it, and returns `{"nonce", "message", "expiresAt"}`:

   ```
   <host> wants you to sign in with your Ethereum account:
   0xChecksummedAddress

   Sign in to Rare City. This only proves you control this wallet: it is not a transaction and it costs nothing.

   URI: <PUBLIC_ORIGIN>
   Version: 1
   Chain ID: 4663
   Nonce: <32 hex characters, 128 random bits>
   Issued At: <now>
   Expiration Time: <now + 5 minutes>
   ```

2. The wallet signs that exact text.
3. `POST /v1/auth/verify` with `{"nonce", "signature"}`. **The message is not sent back.**
   The service recovers the signer over its own stored copy and compares it with the
   address the challenge was issued for, so the address, chain, origin, nonce and lifetime
   a signature covers cannot be swapped. It also re-checks that the stored challenge names
   this deployment's origin and chain.

On success, one transaction marks the challenge consumed
(`UPDATE … WHERE consumed_at IS NULL AND expires_at > now`: of any number of racing
verifications exactly one updates the row), finds or creates the user and wallet, and
inserts the session. A challenge authenticates at most once and only for five minutes. A
wrong signature does not consume it.

An address is accepted in lowercase or with a valid EIP-55 checksum, stored lowercase, and
returned checksummed. Only chain 4663 is accepted. Only externally owned accounts can sign
in: smart-contract wallets (EIP-1271) are not supported yet.

Asking for a challenge needs no credentials, so the table is bounded rather than trusted:
the service keeps only the newest 20,000 challenges and deletes expired or consumed ones
after an hour (and sessions thirty days after they end). A challenge is never refused and
there is no per-address limit, so nobody can stop an address signing in by asking for
challenges on its behalf; to push a visitor's challenge out before they sign it, an
attacker has to issue 20,000 in those few seconds. Asking is limited per client network
(see "Edge" below), never per address asked about.

### Sessions and the cookie

- The credential is 32 random bytes (`crypto.randomBytes`), base64url, held only in a cookie.
- The database stores only its SHA-256 (`sessions.token_hash`). Nothing in the database or
  the logs can be presented as a session.
- Cookie: `__Host-rc_session=…; Path=/; HttpOnly; SameSite=Strict; Secure; Max-Age=604800`.
  In `APP_MODE=local` (plain http) it is `rc_session` without `Secure`.
- **Lifetime: 7 days, absolute.** Using a session does not extend it.
- **Rotation:** every sign-in creates a new credential. The session the browser arrived
  with is revoked in the same transaction, and a presented value is never adopted as the
  new session.
- **Revocation:** `POST /v1/auth/logout` sets `revoked_at` and expires the cookie. Sessions
  can also be revoked directly in the database.
- A missing, malformed, expired or revoked cookie is simply an anonymous visitor (and
  `/v1/viewer` clears it). It is never an error, and it never affects `/v1/city`.

### Transactions and pooled connections

Sign-in and activation share one pool, and a pooled connection carries its transaction
with it. So the rule is the same for both: **a connection goes back to the pool only when
it is known to be outside a transaction**. A connection whose transaction state is
uncertain is closed, which makes the database abandon the transaction; it is never handed
to another request, whose `COMMIT` would make somebody else's half-finished work permanent.

`verify` runs its transaction through `withTransaction` (`db/transaction.ts`):

| What failed | What happens to the connection |
| --- | --- |
| Nothing: `COMMIT` answered | Returned to the pool. |
| An `AuthError` the service raised (for example a challenge consumed by a racing request) | `ROLLBACK`, then returned to the pool. |
| An error the database reported (`pg.DatabaseError`), including a `COMMIT` it refused | `ROLLBACK`, then returned to the pool. |
| A `ROLLBACK` that fails, after either of those | Closed. |
| Anything else: a statement that timed out on the service's side, a dropped connection, a transport failure, a `COMMIT` that did not come back | Closed. No `ROLLBACK` is sent. |
| The connection dropped between statements (`pg` reports this as an `error` event) | Closed. No `ROLLBACK` is sent. |

The pool's `query_timeout` only stops the service waiting: the statement may still be
running on the server, and a `ROLLBACK` queued behind it may never be sent. That is why a
client-side timeout is never followed by a best-effort `ROLLBACK` and a release.

A `COMMIT` that does not come back may or may not have happened. Nothing is assumed: the
caller gets `503 auth_unavailable` and no cookie. If it did commit, the session exists but
its credential was never returned to anyone, and the challenge is spent.

What the visitor sees is unchanged: the same answers, the same statuses, the same cookie.
The activation service applies the same rule in its own transaction helper (see "The
transaction" under "Permanent Friend activation"). Statements sent straight to the pool
(`pool.query`) run outside any transaction, and `pg` closes the connection itself if one
fails. Operator commands (`db:migrate`, `city:genesis`, `city:seed-demo`, `city:verify`)
run in their own short-lived processes with their own pools.

### CSRF: the rule for every request that changes anything

`assertSameOrigin` in `http.ts` runs before the body is read and before any handler:

1. `Origin`, when present, must equal `PUBLIC_ORIGIN` exactly.
2. `Sec-Fetch-Site`, when present, must be `same-origin`.
3. The body must be `application/json` (a cross-site form cannot send that without a
   preflight, and the service never answers one: it emits no CORS header at all).
4. The session cookie is `SameSite=Strict`, so a cross-site request does not carry it.
5. `GET` and `HEAD` never change anything.

**Every mutating route must be declared in the `posts` table in `app.ts`.** A route there
is a `PostRoute`: its client rate limit, what to answer if it fails unexpectedly, and its
handler. `servePost` is the one boundary in front of all of them, and runs in this order
before a handler sees anything:

1. `POST` only (`405` otherwise);
2. the same-origin rule above (`403 origin_mismatch`);
3. the route's client rate limit (`429 rate_limited`), counted before the body is read so a
   malformed or oversized body is still a counted request;
4. the body: `application/json` only, at most 4 KiB, a JSON object (`415`, `413`, `400`).

The handler receives `{ req, res, body, client }` and nothing it has to re-check. A
mutating route must not be reachable any other way, and must not be a `GET`. Limits keyed
by the signed-in user are applied by the handler, once it knows who that is.

### `GET /v1/viewer`

```
{ "authenticated": false }

{ "authenticated": true,
  "userId": "<uuid>",                              // stable server id, not a wallet address
  "wallet": { "address": "0x…", "chainId": 4663 }, // the wallet that signed in to this session
  "session": { "expiresAt": "2026-10-09T12:00:00.000Z" } }
```

`503 {"error":"viewer_unavailable"}` if the session store cannot be read. Without a
database everyone is anonymous. A user's other wallets are never exposed.

### `GET /v1/viewer/friends`

```
{ "wallet": { "address": "0x…", "chainId": 4663 },
  "source": "robinhood-chain",                     // or "fixture" (local only, not real ownership)
  "asOfBlock": "78010453",
  "friends": [ { "tokenId": "812", "family": { "id": 2, "name": "Family" },
                 "property": { "id": "29d2ac0a-1754-8500-acdd-802ba2c51575", "buildingId": "b-812",
                               "districtId": "d4", "ward": 0, "plot": 7, "plotId": "d4-w0-p7",
                               "activatedAt": "2026-10-03T20:11:32.123Z" } },
               { "tokenId": "1204", "family": { "id": 0, "name": "Skeleton" }, "property": null } ] }
```

Token ids are decimal strings (uint256). The wallet is always the session's; nothing in the
request can name another, and no list of tokens is ever accepted from a browser.

`property` says whether the Friend already has a permanent Rare City property: the public
facts of it, or `null` for none. It is read from the normalized `properties` table and
never from a user's avatar (`state.users[*].friendId`). The key is **absent** when the
service could not tell (no database, or the read failed): absent means unknown, not none.
The current client ignores the key.

- `401 not_authenticated` when not signed in.
- `503 ownership_unavailable` when ownership could not be read. This is never reported as
  an empty list.
- `422 ownership_too_large` when the wallet holds more than 2,000 Friends.

A successful answer is reused for 30 seconds per wallet. This is a display cache: anything
that decides what a wallet may do must call `OwnershipProvider.verifyOwnership` directly.

### Ownership

The core depends only on `OwnershipProvider` (`listOwnedFriends`, `verifyOwnership`,
`resolveFamily`). Everything specific to Rare Friends lives in the adapter, and the chain
values live in one file, `src/config/rareFriends.ts`:

| | |
| --- | --- |
| Chain | Robinhood Chain mainnet, `chainId` 4663 |
| Public RPC | `https://rpc.mainnet.chain.robinhood.com` (override with `ROBINHOOD_RPC_URL`) |
| Generations (ERC-721) | `0x14C49e6118F46525dE9ab41a51cBAA3c6EBF181D` |
| First Transfer block | `63102373` |
| Families Registry | `0x246E3E9730A7Eade94c79be0Fd78d210f89AEb8D`, `familyOf(uint256) -> uint8` |
| Generation metadata | `0x3A243E7f46970275CaE8375b0032e53dF91a9110` (recorded, unused) |
| RF | `0x0779369854d3EcdEA927206718FFD7730C67B71f`, 18 decimals (recorded, **never read or moved**) |
| Families | 0 Skeleton, 1 Mask, 2 Family, 3 Cellular, 4 Asymmetry, 5 Hoverer, 6 Colossus, 7 Sparkling, 8 Hollow |

Generations has no owner enumeration (it does not implement ERC721Enumerable), so the
adapter does what the public Rare Friends SDK does, with every read pinned to one block:

1. check the endpoint is chain 4663;
2. `balanceOf(wallet)`; zero is an authoritative empty answer;
3. read the wallet's own `Transfer` logs, incoming and outgoing, filtered by the indexed
   account topic, from the first Transfer block to the pinned block. The collection is
   never scanned;
4. replay them in chain order into the set of token ids still held;
5. require that set to be exactly as large as `balanceOf` (a truncated history fails here);
6. confirm `ownerOf(tokenId) == wallet` for every one;
7. `familyOf(tokenId)` for every one; an id outside 0-8 is an error.

Transfer history only nominates candidates: a Friend is returned because the contract says
the wallet owns it. The registry answers `familyOf` for any number, minted or not, so a
family is only ever resolved for a token whose ownership was confirmed first.

Limits: log queries span at most 10,000,000 blocks (the public RPC's limit) and halve when
the provider rejects a range or result size, down to 50,000 blocks; at most 96 log requests,
50,000 logs and 2,000 Friends per read; contract reads are batched 200 per call through
Multicall3 with four in flight; 10 s per request and a hard 25 s per read. Any failure is
`OwnershipError`, never an empty wallet.

`verifyOwnership` and `resolveFamily` treat a contract revert as an answer ("no such
token"). Only the node's "execution reverted" code together with real ABI error bytes
counts as a revert; an internal error, a rate limit or a timeout is `unavailable`, never
"not the owner".

Only `eth_chainId`, `eth_blockNumber`, `eth_getLogs` and `eth_call` are sent, and only to
the configured endpoint: viem's CCIP-Read (off-chain lookup) is disabled, so no contract
answer can make the service fetch a URL. Outside local mode the endpoint must be `https://`.
OpenSea is not consulted for anything.

The **fixture provider** is a fixed table for local work and tests. Every answer it gives
is labelled `"source":"fixture"`, the client shows it as `TEST FIXTURE · NOT REAL
OWNERSHIP`, and configuration refuses it outside `APP_MODE=local`.

### Not done yet

Known and deliberate, to be settled before anything of value depends on a session:

- **Rate limits are per process and not yet proven against Railway's edge.** They are held
  in memory, which is right for one replica; with more, each replica allows its own limit.
  `TRUSTED_PROXY=railway` believes `X-Real-IP`, and Railway does not document whether its
  edge overwrites a value a client sends. That has to be shown on staging (see "Edge")
  before the limits are relied on there. `GET /v1/viewer`, `GET /v1/city` and
  `POST /v1/auth/logout` are not limited.
- **Smart-contract wallets** (EIP-1271) cannot sign in.
- **A signature can be relayed.** As with any Sign-In with Ethereum flow, a phishing site
  can fetch a challenge for a victim's address and, if the wallet does not warn that the
  message names another site, obtain a signature and a session. Today a session only shows
  public ownership. Before sessions can act (P0-D), consider binding sign-in to the
  browser that asked for the challenge.
- **HSTS makes no promise beyond this host.** No `includeSubDomains` and no `preload`;
  production starts at one day (`HSTS_MAX_AGE`).
- **Answers written by Node itself carry no security headers**: a request too malformed to
  parse, or one that times out before it is complete, never reaches the app.
- **Log responses are size-limited only by the RPC provider.** The 50,000-log ceiling is
  applied after a response has been received.
- **One wallet per user.** The schema allows several; nothing links a second one yet.

## Edge: client network, rate limits, response headers

Everything here exists so that routes which change something permanent can be added
safely. None of it changes the city.

### Which network a request came from

Used for rate limiting only. It is configuration, never something a request says about
itself (`clientKey.ts`):

| `TRUSTED_PROXY` | The client network is | |
| --- | --- | --- |
| `none` | the socket's peer address | Default in `local`. Every header a client can send about itself is ignored. |
| `railway` | Railway's `X-Real-IP` header | The process must be reachable only through Railway's edge. |

- `staging` and `production` must set `TRUSTED_PROXY` explicitly; it is never inferred from
  the platform. Without it the process, and `db:migrate`, refuse to start.
- `X-Forwarded-For` is **never** read, in any mode. Neither is `Forwarded` or any other
  forwarding header.
- In `railway` mode a missing or unusable `X-Real-IP` (absent, repeated, not an address, an
  address with a port) is not replaced by another header. Such requests share **one**
  bucket, `unidentified`, with the same limits as a single client, and a warning is logged
  at most once a minute. The warning carries a count and no address.
- One spelling per network: IPv4 as its dotted form; an IPv4-mapped IPv6 address
  (`::ffff:a.b.c.d`) as that IPv4 address; IPv6 as its `/64`, since one subscriber is
  routinely given a whole `/64`.
- Addresses are not logged. The request log carries `client`, eight hex characters of an
  HMAC of the network key under a key generated at start-up, and `clientSource`
  (`socket`, `x-real-ip` or `fallback`). The tag tells two clients apart within one
  process's log and cannot be turned back into an address or matched across restarts.

### Rate limits

`rateLimit.ts`. "At most N in any window", counted exactly: each key keeps the times of the
requests it was allowed. A refused request is not recorded, so being refused does not
extend the wait. `Retry-After` is the number of seconds until a place frees up.

| Route | Per client network | Per signed-in user |
| --- | --- | --- |
| `POST /v1/auth/challenge` | 10 / minute | |
| `POST /v1/auth/verify` | 10 / minute | |
| `GET /v1/viewer/friends` | 30 / minute | 6 / minute |
| `POST /v1/activation/intents` | 10 / minute | 6 / minute |
| `POST /v1/activations` | 10 / minute | 6 / minute |

- A key is always **who is asking**: the client network, or the user id from the session.
  It is never the address in a challenge request, a wallet being signed in, or a token id.
  A bucket keyed by something a request merely mentions could be emptied by anyone to lock
  the real owner out.
- The client limit runs before any database or chain work: on the sign-in routes before the
  body is read, on `/v1/viewer/friends` before the session is looked up. The user limit
  runs as soon as the session is known and before the ownership provider is asked. The
  activation routes do both: the client limit before the body, the user limit before the
  activation service (and so before its chain read).
- A request from another origin is refused (`403`) before it is counted, so a hostile page
  cannot spend a visitor's allowance.
- A limiter takes several rules at once and counts against all of them or none, which is
  what a route with a per-minute and a per-hour limit on the same user needs.
- Time comes from the process's monotonic clock, so a correction to the system clock cannot
  lengthen or shorten anyone's wait.
- At most 50,000 buckets are held; past that the one unused for longest is dropped. A
  client that is being refused counts as in use.
- `RATE_LIMITS=off` exists for the browser tests, which sign in far faster than a visitor.
  It is refused unless `APP_MODE=local`.

### Response headers

`securityHeaders.ts`. Every answer the app writes carries:

```
X-Content-Type-Options: nosniff
Referrer-Policy: same-origin
Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()
Cross-Origin-Opener-Policy: same-origin-allow-popups
Strict-Transport-Security: max-age=<HSTS_MAX_AGE>          (staging and production only)
```

The app shell (`index.html`, including every client-side route) carries:

```
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self';
  img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; object-src 'none';
  base-uri 'none'; form-action 'none'; frame-src 'none';
  frame-ancestors 'self' <FRAME_ANCESTORS>; upgrade-insecure-requests
X-Frame-Options: SAMEORIGIN                                 (only while FRAME_ANCESTORS is empty)
```

Everything else (JSON, static files, errors) carries:

```
Content-Security-Policy: default-src 'none'; frame-ancestors 'none'
X-Frame-Options: DENY
```

- **No `'unsafe-inline'` and no `'unsafe-eval'` anywhere**, for scripts or styles. Chromium
  required no exception: the app's styles are one stylesheet file plus React `style={{…}}`
  props, which React applies as style *properties* (the CSSOM), and a policy does not
  restrict those. It restricts style *text*: a `style="…"` attribute in markup or set with
  `setAttribute`, and a `<style>` element. The app has neither. `e2e-server/csp.spec.ts`
  runs the built app in Chromium with a `securitypolicyviolation` listener and requires
  zero violations, then shows the policy refusing inline script, `eval`, style text, a
  request and a frame to another origin, and being framed by another site.
- `data:` and `blob:` images are billboard images: stored as data URLs, previewed from a
  local file while cropping.
- `connect-src 'self'` is enough because the page makes no RPC calls; an injected wallet
  talks to its own extension. A wallet transport that connects from the page (WalletConnect,
  for example) would need its relay added.
- **Local mode** (plain `http://`) sends the same policy without `upgrade-insecure-requests`
  and without HSTS, so a developer machine stays usable. Nothing else differs.
- **Framing.** `FRAME_ANCESTORS` lists the exact `https://` origins, besides this one, that
  may frame the app. Empty by default: same-origin only. Each value must be spelled exactly
  as a browser sends an origin (a lowercase dotted host name, no default port, no path, no
  trailing slash, no wildcard); anything else stops the process at start-up. It is never derived
  from a request. `X-Frame-Options` cannot name a parent, so the app shell stops sending it
  once a parent is listed. Data and files refuse every parent regardless.
- A framed Rare City is read-only by construction: the session cookie is `SameSite=Strict`
  and is not sent to a frame inside another site.

### The staging proof still owed

`TRUSTED_PROXY=railway` is only safe if Railway's edge **replaces** an `X-Real-IP` a client
sends. To show it: send two requests to staging from one machine, one of them with a forged
`X-Real-IP`, and compare the `client` tag on the two request-log lines. The same tag means
the edge overwrote the header. A different tag means it did not, and the limits must not be
relied on until the edge is configured to.

## The city in Postgres

Migration `0002` adds two tables. It installs no city.

- `city`: one row. `state` is the whole `GameState` as `json`, with `sequence`,
  `state_version`, `instance_id`, `canonical` and `origin`. Constraints reject a state that
  is not an object, a `state_version` that disagrees with the state, a sequence below 1, and
  a `canonical` flag that disagrees with `origin`.
- `city_events`: append-only, one row per sequence value, written in the same transaction as
  the change it explains. Today the only event is `city.initialized`.

`json` rather than `jsonb` on purpose: `jsonb` reorders object keys, and some of the
renderer's choices follow key order. With `json` the state round-trips byte for byte.

Migration `0003` adds identity, and touches nothing else:

- `users`: `id` (uuid), `created_at`, `updated_at`. Not keyed by a wallet.
- `wallets`: `id`, `user_id`, `chain_id`, `address`, `created_at`, `last_verified_at`.
  `address` must match `^0x[0-9a-f]{40}$` and `(chain_id, address)` is unique, so one
  address cannot become two rows in different spellings. A user may have several.
- `sessions`: `id`, `token_hash` (exactly 32 bytes, unique), `user_id`, `wallet_id`,
  `created_at`, `expires_at`, `revoked_at`.
- `auth_challenges`: `nonce` (primary key), `chain_id`, `address`, `message`, `issued_at`,
  `expires_at`, `consumed_at`.

Ownership of Friends is not stored anywhere: it is read from the chain when asked for.

Permanent Friend activation is the one thing that changes the city: it locks the `city`
row, applies the engine's pure transition, writes the new state with `sequence + 1`, and
appends the matching `city_events` row, all in one transaction (see "Permanent Friend
activation"). Gameplay commands will follow the same shape in a later slice.

## Activation foundation (migration 0004)

Structure, guards and operator tools: what an activation is written into. Migration `0004`
adds columns, tables and triggers only; it does not touch an existing city's state,
sequence, instance or events. The service that writes these tables is described in
"Permanent Friend activation" below, and it is off unless `ACTIVATION_ENABLED=true`.
Migration `0004` is applied on staging and is never edited: any schema change is a new
migration.

### Three kinds of city

| | `canonical` | `origin` | `activation_rehearsal` | May hold real properties |
| --- | --- | --- | --- | --- |
| Canonical genesis | `true` | `genesis` | `false` | yes |
| Ordinary demo fixture | `false` | `demo-fixture` | `false` | **no** |
| Activation rehearsal | `false` | `demo-fixture` | `true` | yes |

`origin` keeps its two values. `activation_rehearsal` (default `false`) marks a disposable,
empty, genesis-shaped city in which activation can be exercised for real on staging. A
constraint forbids it on a canonical city. The `city` row is guarded by triggers:

- a canonical city can only exist in a database stamped `production`, and a production
  database can only hold a canonical city;
- a city is inserted at sequence 1, and one that may hold properties only with an empty
  `buildings` object;
- what a city is never changes: its `id`, `instance_id`, `canonical`, `origin` and
  `activation_rehearsal` are permanent, so a populated fixture can never be relabelled;
- its `sequence` moves forward one step at a time and never back, and its `state` only
  changes together with the sequence;
- a production city cannot be deleted.

The environment stamp those guards rely on is guarded too: once `app_meta` says
`production` the row cannot be changed or removed, and a database holding a non-canonical
city cannot be re-stamped `production`. So is the identity that intents and eras name: a
`wallets` row keeps its address and chain, and a `sessions` row keeps its user, wallet,
credential and lifetime, and once revoked stays revoked (a session can end; it cannot be
handed on, extended or revived).
Which user a wallet belongs to is deliberately not frozen (a wallet is not assumed to be
one person forever), so the "this wallet is this user's" check on an intent or era is true
at the moment of the write; `city:verify` reports an era whose wallet no longer belongs to
its user.

**What the guards do and do not withstand.** Every guard function is pinned to its own
schema with temporary tables searched last, so a session cannot switch a guard off by
creating a temporary table named like the ones it reads (this also fixes
`city_guard_canonical` from `0002`). They hold against any ordinary `INSERT`, `UPDATE` or
`DELETE`, whatever code issues it. They do **not** hold against the table owner or a
superuser, who can `TRUNCATE`, disable a trigger or set `session_replication_role`. Today
the service connects as the role that owns the tables. **Before canonical production, the
service must run as a role that does not own them**; that is a provisioning step, not
something a migration can do.

### Tables

- **`properties`**: one permanent row per activated Friend: the city installation it
  belongs to, chain, collection, token id, family, district, ward, plot, plot id, building
  id, when and at which city sequence it was activated, by whom, through which intent, and
  the chain block at which ownership was verified. Unique per `(chain, collection, token)`,
  per `(city, plot)`, per `(city, building)`, per intent and per sequence. Checks pin the
  chain to `4663` and the collection to Generations, the token id to a whole number `0 ..
  9007199254740991` (the city state holds a Friend id as a JavaScript number; the column is
  an unscaled `numeric`, so `1.5` or `812.0` is refused rather than rounded), the family
  to its district (`0 Skeleton d8 · 1 Mask d6 · 2 Family d4 · 3 Cellular d5 · 4 Asymmetry
  d7 · 5 Hoverer d9 · 6 Colossus d3 · 7 Sparkling d2 · 8 Hollow d1`), `plot_id` to
  `<district>-w<ward>-p<plot>` and `building_id` to `b-<token id>`. Composite foreign keys
  tie it to the exact city installation `(id, instance_id)` and to the exact event
  `(city_id, sequence)`. A trigger refuses a property unless its city may hold properties,
  it is exactly what its *issued, unexpired* intent authorised, and a `property.activated`
  event exists at the sequence the city has just reached. At commit, a second (deferred)
  trigger refuses a property whose intent was not committed to it or which has no first
  ownership era, so a half-finished activation can never be committed.
  **`UPDATE` is always refused; `DELETE` is refused in production.**
- **`ownership_eras`**: who a property has belonged to. Era 1 opens at activation and
  belongs to the activating wallet; a later era would open after a transfer (not
  implemented). Numbered consecutively per property, at most one open, each opening only
  after the one before has closed, normalised owner address, and the address, wallet and
  user naming one owner. **The only `UPDATE` is closing an era, once.** `DELETE` is refused
  in production.
- **`activation_intents`**: what a wallet was asked to sign: a 32-byte id, user, wallet,
  session, owner address, chain, collection, token id, family, city installation, plot,
  origin, the 32-byte EIP-712 digest, issue and expiry times, the block at issue, and a
  status of `issued`, `committed` or `superseded`. At most one `issued` intent per wallet
  and Friend.
  - **Issuing.** An intent begins as `issued`, for a city that may hold properties, by one
    user through their own wallet, **inside a live session of that user and wallet**: the
    session is required, must not be revoked, must not have expired, and must contain
    `issued_at`. `issued_at` must be **now** (within a minute of the database's clock), the
    intent lives **at most ten minutes**, and never past its session's expiry: the service
    must clamp the expiry of an intent issued in a session's last ten minutes. Its origin
    is a bare lowercase origin, and `https://` unless the database is stamped `local`.
  - **Committing.** `issued -> committed` requires a time inside the intent's lifetime, a
    65-byte signature and the property that names this intent. It is refused unless the
    **same session still exists, is still that user's and wallet's, is not revoked and has
    not expired**, and unless the intent itself has not expired. The session row is locked
    until the transaction ends, so it cannot be revoked in between.
  - **Time** in these rules is the database's wall clock at the moment of the write
    (`clock_timestamp()`), not when the transaction began and not the time a writer claims.
    The service's and the database's clocks must agree within a minute.
  - **Nothing is left to a foreign key.** Each rule requires the row it depends on to be
    there, so a row added later in the same statement cannot dodge it.
  - **Superseding** needs no session.
  - **`session_id`** is nullable only so the intent can outlive its session. It becomes
    `NULL` when the session row is deleted (the foreign key's `ON DELETE SET NULL`), in any
    status, and only then: detaching a session that still exists is refused. **Signed fields can never change.** The
  only transitions are `issued -> committed` and `issued -> superseded`. The one other
  change allowed is `session_id` becoming `NULL`: that is the `sessions` foreign key
  (`ON DELETE SET NULL`) doing its normal clean-up, so session retention keeps working.
- **`city_events`** is now append-only by trigger: an event can only be inserted at the
  sequence its city has just reached, **`UPDATE` is always refused, and `DELETE` is refused
  in production.** Outside production, removal stays possible for the one operator command
  below that replaces a disposable fixture.

Not enforced by the database:

- ward capacity and which plots are candidates: the engine's rules, checked by the
  invariants below;
- the spelling of a token id: the database refuses anything that is not a whole number in
  range (`1.5`, `812.0`, `NaN`), but Postgres reads `'0x10'`, `'1e3'`, `'0812'` and `' 812 '`
  as the integers they denote. No value is changed, but the service must accept only a
  canonical decimal string;
- that every sequence has an event: a sequence can be advanced without one, and
  `city:verify` reports it;
- outside production, anything: a non-production database is disposable, and one statement
  that deletes and re-inserts a city gets round "what a city is never changes".

Two operational consequences of the guards: a **data-only** reload into an existing schema
cannot replay events or properties past them (restore from a full dump, where triggers are
created after the data), and migration `0004` gives up after 10 seconds if another session
is holding one of the tables it alters, rather than queue readers behind it.

### Which layer is the truth

`properties` and `ownership_eras` are the authority for which Friend has a property, where,
and whose it is. `city.state` is the authority for gameplay and *projects* each property as
a building. In a city that may hold properties the two must agree, and `city:verify` checks
it: the same set of buildings and properties, the same Friend, district, ward and plot for
each, and each building owned in the state by the user of its property's open era. If they
ever disagree, the property rows win.

### Users in the city state are presentation

`state.users[*]` is a `CityUser`: an id, a handle and an avatar. Its `friendId` picks which
Friend is drawn as the avatar and **is never authority**: it does not prove ownership, does
not limit a user to one Friend, and grants no control over a property. Who may act comes
from the session, a fresh ownership read from the chain, and `properties` /
`ownership_eras`. Activation creates a user's display record the first time they activate a
Friend (a neutral handle and hue derived from the wallet address, that Friend as avatar)
and never changes it afterwards: a second Friend does not replace the avatar. (`DemoUser` remains as an alias of the same shape for the demo code; the
serialised shape and `STATE_VERSION` are unchanged.)

### Authoritative invariants

`isCityStateShape` says a state can be drawn. `src/game/invariants.ts` says a state is one
an authority may hold. It is pure, shared with the client, and run before a city is
installed, by the staging reset, and by `city:verify`:

- **state**: supported version; every collection the right kind; every district present
  with a positive whole number of open wards and none open beyond the last occupied one;
  whatever is held is held by a real district or building; a Representative is a building
  its user owns; no simulated wallets in a city that may hold real properties.
- **buildings**: the map key is the building's id; the id is `b-<friendId>`; the Friend id
  is a non-negative safe integer and unique; a valid district; ward and plot non-negative
  integers; the ward is open; the plot is within the ward's capacity; no two buildings on
  one plot; the owner and every patron is a user of the city; each part is the kind of
  thing it should be.
- **users**: the map key is a plain id and is the user's id; the avatar Friend id is
  well-formed. Nothing is inferred from it.
- **mode**: the city is one of the three kinds above. Anything else is rejected, never
  treated as a fixture.
- **properties** (canonical and rehearsal cities): the buildings and the property rows are
  the same set, and each pair agrees on Friend, building id, district, ward, plot and
  family district. An ordinary demo fixture is recognised as such: its simulated buildings
  are not properties, so parity is not asked of it, and it must have no property rows.

### `npm run city:verify`

Read-only. One `REPEATABLE READ, READ ONLY` transaction reads the city, its events, its
properties, their eras and the intents, then checks the invariants above plus: events
numbered `1..sequence` starting with `city.initialized`, one `property.activated` event per
property at the property's sequence, every property the property of a committed intent,
eras numbered from 1 with only the latest open, each era's address, wallet and user naming
one owner, and each building owned in the state by the user of its open era.

- exit `0`: valid, with one `city verified` line of metadata and counts;
- exit `1`: invalid; each violation is logged with its `category` (`city`, `mode`,
  `state`, `buildings`, `users`, `properties`, `events`, `eras`, `intents`), `rule` and
  detail;
- exit `2`: the check could not be run.

## Genesis, the rehearsal city and the staging fixture

**Nothing installs or replaces a city automatically**: not a migration, not a deploy, not
the service at start-up, not a request. Only these operator commands do, each run by hand.

`createGenesisState()` is the empty city: no users, no buildings, no simulated wallets, no
badges or counters, nothing held, no history, no radio, one founding ward open per
district, and a neutral season (`Preseason`, number `0`). The civic world a visitor sees is
drawn from configuration, so an empty state is still a whole city.

```
npm run city:genesis -- --help
```

| Command | Installs | Requires |
| --- | --- | --- |
| `city:genesis -- canonical --confirm-city main --confirm-environment production` | the **canonical** empty city | `APP_MODE=production`, database stamped `production`, no city present |
| `city:genesis -- rehearsal --confirm-city main --confirm-environment staging` | an empty **non-canonical rehearsal** city | `APP_MODE=staging`, database stamped `staging`, no city present |
| `city:seed-demo -- --non-canonical` | the 180-resident **demo fixture** (simulated, not a rehearsal) | not production, no city present |

Each is one transaction that writes the city at sequence 1 with exactly one
`city.initialized` event, and each refuses once any city exists.

### Replacing the staging fixture: `replace-staging-fixture`

The one destructive command. It swaps staging's disposable demo-fixture city for an empty
rehearsal city, and nothing else.

```
npm run city:genesis -- replace-staging-fixture --confirm-city main --confirm-environment staging \
    --confirm-reset replace-demo-fixture --expect-instance <uuid> --expect-sequence <n>
```

It refuses unless **all** of these hold:

- `APP_MODE=staging`, and the database is stamped `staging`;
- all three confirmations are given exactly;
- the city's `instance_id` and `sequence` are exactly the ones supplied;
- the city is `canonical=false`, `origin=demo-fixture`, `activation_rehearsal=false` (a
  rehearsal city is never replaced by this command);
- there are no properties, no ownership eras and no activation intents of any status;
- no event in its history is an activation event;
- its events are exactly `1..sequence` starting with `city.initialized`, and its state
  passes the authoritative invariants.

It locks the city row first and checks every condition under that lock. Then, in the same
transaction, it removes that city's events and row and installs a **new** city: new
`instance_id`, sequence 1, genesis state, `activation_rehearsal=true`, and one
`city.initialized` event that records what was replaced. Any failure rolls all of it back.
It cannot run against production: the command refuses the mode and the stamp, and a
production database refuses the removals itself.

Run `npm run city:verify` before and after.

### The demo fixture

The familiar 180-resident demo city is **NON-CANONICAL**: simulated residents, simulated
RF. `city:seed-demo` refuses to run without `--non-canonical`, when `APP_MODE=production`,
against a database stamped for another environment, and once a city exists. Its buildings
are not properties and the database refuses to give it any.

## Permanent Friend activation

`activation/service.ts`. The signed-in owner of a Rare Friend turns it into a permanent
Rare City property on one exact plot. **Server only**: no screen uses it yet. **No RF and
no NFT moves**: the wallet signs a message, and nothing here signs or sends a transaction.

### The switch: `ACTIVATION_ENABLED`

Off unless the variable is exactly `true`. `false` and unset are off; anything else
(`1`, `yes`, `on`, `TRUE`) stops the process at start-up rather than being guessed at.
Nothing else switches it on: not `APP_MODE`, and not the kind of city in the database.

While it is off both routes answer `403 {"error":"activation_disabled"}` before the session
is looked up, so before any database read, chain read or write. Sign-in, `/v1/viewer`,
`/v1/viewer/friends` and `/v1/city` are unaffected. The start-up log line reports
`activationEnabled: true|false` and nothing else about it.

### What authorises an activation

Not a session. A session says which wallet signed in; an activation needs all of:

1. the **exact session** the intent was issued in (resolved server-side from the cookie to
   its database row; the session and wallet row ids are never sent to a browser),
2. the wallet's **EIP-712 signature** over the message the server wrote and stored,
3. the **chain** saying, at issue and again immediately before the write, that the
   session's wallet owns the Friend, and which family it is.

Family, district and city are never taken from the request. A user's avatar is never read.

### `POST /v1/activation/intents`

Request, exactly these two keys:

```
{ "tokenId": "812", "plotId": "d4-w0-p7" }
```

`tokenId` is **canonical base-10 text**: `0`, or digits with no leading zero, from 0 to
9007199254740991 (the city state holds a Friend id as a JavaScript number). `+1`, `-1`,
`01`, `0812`, `1.0`, `1e3`, `0x10`, anything with whitespace, and a JSON number are all
refused, never repaired (`parseCanonicalTokenId` in `src/protocol/activation.ts`). `plotId`
is `<district>-w<ward>-p<plot>` in its one canonical spelling.

In order, the service: checks the switch; requires the session to be on chain 4663; parses
the request; reads the city and its properties in one read-only snapshot; requires a city
that may hold properties (canonical, or an activation rehearsal) and runs the deep
invariant check on it; requires the plot to be one the engine's `allocateSpecificPlot`
offers right now; makes the **pinned chain read**; requires the wallet to own the Friend;
derives the district from the registry family and requires the plot to be in it; then, in
one short transaction, requires that the Friend has no property and the plot belongs to
none, and stores the intent.

```
200
{ "intentId": "<64 lowercase hex>",
  "expiresAt": "2026-10-03T20:21:32.123Z",
  "typedData": { "domain": …, "types": …, "primaryType": "PropertyActivation", "message": … },
  "digest": "0x…" }
```

`typedData` is exactly what a wallet's `eth_signTypedData_v4` takes. `digest` is its
EIP-712 hash, returned for diagnostics: it is public (anyone holding the typed data can
compute it) and the server never trusts a digest sent back.

**Issuing changes nothing in the city and reserves no plot.** Two people can hold intents
for the same plot; the first commit gets it.

### The message: `PropertyActivation` (V1, frozen)

```
domain   { name: "Rare City", version: "1", chainId: 4663 }

PropertyActivation(
  bytes32 intentId, string site, string statement, address wallet, address collection,
  uint256 tokenId, uint8 familyId, string familyName, string cityId, string cityInstance,
  string districtId, uint32 ward, uint32 plot, string plotId, uint64 issuedAt, uint64 expiresAt )
```

- There is **no `verifyingContract`**. No contract verifies these signatures (this server
  does), and the Generations NFT contract is not an EIP-712 verifier. `collection` is in
  the message as the thing being activated, not as a verifier.
- `statement` is always `Activate this Rare Friend as a permanent Rare City property.`
- `site` is `PUBLIC_ORIGIN`. `cityInstance` is the exact installation of the city: a
  signature for one installation means nothing in another.
- `issuedAt` and `expiresAt` are **Unix milliseconds**, by the database clock.
- The **city sequence is deliberately not signed**: unrelated activity in the city does
  not invalidate an intent whose own plot is still free.
- Hashing and recovery are viem's (`hashTypedData`, `recoverAddress`). Nothing here
  implements a hash or a curve. EOA signatures only; EIP-1271 is deferred.

The format is frozen. A test pins the exact typed data, its digest and a signature, and
recomputes the digest by hand from the EIP-712 specification. Any change to the domain, the
field list, a type, the order or the statement is a new version, never an edit.

### Intent lifetime and the one-live-intent rule

`issuedAt` is the **database's** wall clock, truncated to the millisecond.
`expiresAt = min(issuedAt + 10 minutes, the session's expiry)` and must be after `issuedAt`.
The intent id is 32 random bytes (`crypto.randomBytes`), as 64 lowercase hex characters.
The row stores the session, user, wallet, address, chain, collection, token, family, city
instance, plot, origin, digest, both times and the block the ownership read was pinned to.

There is at most one `issued` intent per wallet and Friend. Issuance for one wallet and
Friend is serialised by a transaction-scoped advisory lock (it gives up after 5 seconds
with `409 activation_conflict`), so the outcome of any race is deterministic:

- the same request again (same session, Friend, city instance, plot, family and origin)
  while the intent has **at least a minute left** returns that same intent, byte for byte;
- anything else (another plot, another session of the same wallet, a changed registry
  family, or less than a minute left) marks the old intent `superseded` and issues a new
  one, in the same transaction.

### `POST /v1/activations`

Request, exactly these two keys. The typed data is **not** accepted back:

```
{ "intentId": "<64 lowercase hex>", "signature": "0x<130 hex>" }
```

The service reads the stored intent and takes everything from it. An intent of another
user is `404 intent_not_found`, exactly as if it did not exist. For an issued intent:

1. the session must be the exact session it was issued in, through the same wallet;
2. it must not have expired (database clock);
3. the stored fields must hash to the stored digest, and the signer recovered from that
   digest and the signature must be the intent's owner address and the session's wallet;
4. **the second chain read**: a new pinned read. The wallet must still own the Friend, the
   family must be the signed family, and the block must not be older than the block the
   intent was issued on. This happens outside any database transaction;
5. one short transaction (below).

A wrong signature never reaches the chain or the transaction.

### The pinned chain read: `OwnershipProvider.verifyActivation`

Used at issue and again before commit. It is never `verifyOwnership()` followed by
`resolveFamily()`, which would be two "latest" reads that can straddle a transfer.

```
eth_chainId                                   must be 4663, or it fails closed
eth_blockNumber                               pins ONE block (never cached)
eth_call  Generations.ownerOf(tokenId)        at exactly that block
eth_call  FamiliesRegistry.familyOf(tokenId)  at exactly that same block
→ { owned, family, blockNumber }
```

Four requests and nothing else: no Transfer history, no Multicall, no CCIP-Read, nothing
reused from an earlier call or from the My Friends cache, and a 15-second deadline. A
Friend that does not exist is `unknown-token`, which is an answer; an endpoint that fails
is `unavailable`, which is not, and is never reported as "not owned". A registry family
outside the nine is `invalid-family`. The adapter has no method that signs or sends.

The district is the registry family's, by the permanent table (also a database constraint):
`0 Skeleton d8 · 1 Mask d6 · 2 Family d4 · 3 Cellular d5 · 4 Asymmetry d7 · 5 Hoverer d9 ·
6 Colossus d3 · 7 Sparkling d2 · 8 Hollow d1`.

### The transaction

After the second chain read, and never holding a transaction across it:

```
BEGIN                                  (lock waits give up after 5 s → 409 activation_conflict)
  lock the intent            FOR UPDATE   re-read it: still issued, same session, not expired
  the session                FOR SHARE    live by the database clock; it cannot be revoked underneath
  lock the city              FOR UPDATE   same id and installation as the intent
  deep invariant check of the locked state against its property rows
  the Friend has no property; the plot belongs to none
  activateFriend(state, …)                the pure engine transition; allocates the exact plot again
  UPDATE city        state, sequence + 1  only from the sequence that was locked
  INSERT city_events 'property.activated' at the new sequence
  INSERT properties                       the deterministic id; activated_at and verified_block
  INSERT ownership_eras                   era 1, the activating wallet, same moment and block
  UPDATE activation_intents               issued → committed: committed_at, the 65-byte signature, property_id
  deep invariant check of what is now STORED, which must also be exactly the transition's result
COMMIT
```

Inside the transaction the database itself bounds the work: `lock_timeout` 5 s,
`statement_timeout` 8 s and `idle_in_transaction_session_timeout` 15 s, all `SET LOCAL`. The
statement limit is below the pool's 10-second client-side limit on purpose, so the database
cancels a stalled statement and says so before the service gives up on it.

**A connection goes back to the pool only when it is known to be outside a transaction.**
After a refusal the service decided on, or an error the database reported, `ROLLBACK` is
sent. After anything else (a statement that timed out on the service's side, a dropped
connection), or if the `ROLLBACK` itself fails, the connection is closed instead, which
makes the database abandon the transaction. A connection that might still hold half an
activation is never handed to another request to commit.

The guards of migration `0004` check expiry again with their own reading of the clock as
each row is written. If an intent (or its session) runs out in the instant between the
service's check and the guard's, the guard refuses the write, everything rolls back, and
the answer is `410 intent_expired` (or `401 not_authenticated`), not a `503`.

Either all of it is written or none of it. The order satisfies the guards of migration
`0004` (the event before the property, the property before its era and before the intent
is committed, completion checked at commit). Every activation of a city queues on the city
row, so each sees the result of the one before; two commits of one intent queue on the
intent row, and the second finds it committed.

**The pure transition** is `activateFriend` in `src/game/activation.ts`, not the demo's
join. It adds one building `b-<tokenId>` owned by the user (nothing built, no patrons,
default architecture, no fixtures or landscaping, a blank billboard), opens exactly the
next ward when the chosen plot lies in it, advances the clock by one, and creates the
user's display record on their first activation only. It does not touch `residentSeq`,
simulated wallets, Representatives, badges, counters, season activity or the Radio.

**The event** carries durable, public facts only: `propertyId`, `tokenId`, `userId`,
`ownerAddress`, `familyId`, `districtId`, `ward`, `plot`, `plotId`, `verifiedBlock`. Never
a session id, a cookie, a signature, a digest, an RPC endpoint or a key.

```
200
{ "status": "committed",
  "property": { "id": "29d2ac0a-1754-8500-acdd-802ba2c51575", "tokenId": "812", "buildingId": "b-812",
                "districtId": "d4", "ward": 0, "plot": 7, "plotId": "d4-w0-p7",
                "activatedAt": "2026-10-03T20:11:32.123Z", "sequence": 2 },
  "city": { "id": "main", "instance": "…" } }
```

### Retrying after a lost answer

If the intent is already `committed`, nothing is run again: the service returns the
property that intent created, read from its row, to the **user whose intent it is** and to
nobody else. No chain read, no write. It works from any live session of that user, whatever
the chain says now, so a client that never saw the first answer can simply send the same
request again and get the same property id and sequence. It is not a property lookup:
another user gets `404 intent_not_found`.

### Deterministic property ids

`activation/propertyId.ts`. A property id is never random. V1, frozen:

```
preimage  rare-city:property:v1|world=rare-city|chain=4663|collection=0x14c49e6118f46525de9ab41a51cbaa3c6ebf181d|token=<canonical-decimal-token-id>
hash      SHA-256 of the UTF-8 preimage
uuid      its first 16 bytes; version nibble set to 8, variant bits set to 10; lowercase 8-4-4-4-12

Rare Friend 812  →  29d2ac0a-1754-8500-acdd-802ba2c51575
```

The city instance is deliberately not in the preimage: a Rare City database that is
restored or rebuilt gives the same Friend the same property id. A different world would
use a different `world=` key. Ownership-era ids are derived the same way from
`rare-city:ownership-era:v1|property=<property-uuid>|era=<n>`.

### Errors

`{ "error": <code> }`, with these statuses. `503` carries `Retry-After`. No answer and no
log line contains a provider's or the database's own error text.

| Code | Status | Meaning |
| --- | --- | --- |
| `activation_disabled` | 403 | `ACTIVATION_ENABLED` is not `true`. |
| `not_authenticated` | 401 | No live session behind the cookie. |
| `invalid_request` | 400 | Not exactly the request shape; a non-canonical token id or plot id. |
| `unsupported_chain` | 400 | The session's wallet is not on chain 4663. |
| `city_not_activatable` | 409 | No city, or a city that may not hold properties. One is never created. |
| `city_inconsistent` | 503 | The city failed its invariants, before or after the write. Nothing was written. |
| `friend_not_owned` | 403 | The session's wallet does not own the Friend, or it does not exist. |
| `friend_already_activated` | 409 | The Friend already has a property. |
| `ownership_unavailable` | 503 | The chain could not be read, answered for the wrong chain, or from a stale block. |
| `ownership_inconsistent` | 503 | The registry returned a family that is not one of the nine. |
| `family_mismatch` | 409 | The family at commit is not the family that was signed. |
| `plot_invalid` | 422 | Not a plot this Friend may take: not real, beyond the next ward, or another family's district. |
| `plot_unavailable` | 409 | The plot is taken. |
| `intent_not_found` | 404 | No such intent for this user. |
| `intent_expired` | 410 | The intent's time is up. |
| `intent_superseded` | 409 | A newer intent replaced it. |
| `intent_session_mismatch` | 403 | Not the session the intent was issued in. |
| `signature_invalid` | 403 | Not a signature of the stored message by the intent's wallet. |
| `activation_conflict` | 409 | Another activation got there first, or held a lock too long. Safe to retry. |
| `activation_unavailable` | 503 | No database, or an unexpected failure. |

### Accepted limits of V1

- **A residual race between the chain read and the write.** The second read is pinned
  moments before the transaction, and a Friend can be transferred in between. The database
  still allows one property per Friend and per plot; what can happen is an activation by
  the wallet that owned the Friend a moment earlier. No transaction is held open across
  RPC work to narrow it.
- **EOA signatures only.** A smart-contract wallet (EIP-1271) cannot activate.
- **Clock agreement.** Intents are timed by the database clock and sessions by the
  service's. If the database clock is behind a session's start, issuing in that session is
  refused (`503`) until it catches up.
- **The chain read trusts the endpoint's latest block.** There is no confirmation depth. A
  provider that is consistently behind is only caught when it falls below the block the
  intent was issued on.
- **Dead intents are kept.** Superseded and expired intents are never pruned yet; a user
  can add at most six a minute.
- **Each request reads the whole city.** Issue and commit load the city state and its
  property rows and run the deep check (commit does it twice, under the city lock), so the
  cost grows with the city. It is bounded by the per-user and per-client limits.
- **The My Friends annotation does not depend on the switch.** It is a read of
  `properties`, and with activation off it simply reports `null` for every Friend.
- **Rate limits are per process**, as for every other route.
- **A canonical production city still needs a non-owner database role**: the guards hold
  against ordinary writes, not against the table owner.

## Environment

| Variable | Used by | Notes |
| --- | --- | --- |
| `APP_MODE` | server | `local` (default), `staging` or `production`. A process with `NODE_ENV=production` must set it explicitly. |
| `DATABASE_URL` | server, `db:migrate`, `city:seed-demo` | `postgres://` URL. Optional in `local`, required otherwise. Never logged. |
| `PUBLIC_ORIGIN` | server | The one origin browsers reach this service at, e.g. `https://rarecity.example`. Written into sign-in messages and required of every `POST`. **Required, and must be `https://`, in `staging` and `production`.** In `local` it defaults to `http://<HOST>:<PORT>`. |
| `ROBINHOOD_RPC_URL` | server | Robinhood Chain RPC endpoint. Defaults to the public RPC. Must be `https://` in `staging` and `production`. May contain provider credentials: it is never logged or echoed. |
| `OWNERSHIP_PROVIDER` | server | `robinhood` (default) or `fixture`. `fixture` is refused unless `APP_MODE=local`. |
| `TRUSTED_PROXY` | server, `db:migrate`, `city:seed-demo` | `none` or `railway`: where the client network is read from. **Required in `staging` and `production`**; defaults to `none` in `local`. |
| `FRAME_ANCESTORS` | server | Exact `https://` origins allowed to frame the app, separated by spaces or commas. Empty (default) = same-origin only. A malformed value stops start-up. |
| `HSTS_MAX_AGE` | server | `Strict-Transport-Security` lifetime in seconds, 0 to 63072000. Defaults: one day in `production`, one year in `staging`. Not sent in `local`. |
| `RATE_LIMITS` | server | `on` (default) or `off`. `off` is refused unless `APP_MODE=local`. |
| `ACTIVATION_ENABLED` | server | Exactly `true` or `false`; unset is `false`. Anything else stops start-up. Only `true` lets the two activation routes run. Not set on any deployment. |
| `PORT` | server | Default `8787`. |
| `HOST` | server | Default `127.0.0.1` in `local`, `0.0.0.0` otherwise. |
| `RAILWAY_GIT_COMMIT_SHA` / `GIT_SHA` | server | Reported by `/version`. |
| `TEST_DATABASE_URL` | tests | Disposable database; name must end in `_test`. |
| `REQUIRE_DB_TESTS` | tests | `1` turns a missing test database into a failure instead of a skip. |
| `VITE_APP_MODE` | client build | `local-demo` (default) or `server`. Set by `npm run build:app`. |

The demo client needs none of these. See `.env.example`.

## Scripts

```
npm run dev:server         # watch mode (tsx), reads .env if present
npm run typecheck:server
npm run build:server       # type-check, then bundle the service to dist-server/
npm run build:app          # build:server, then the server-mode client into dist-server/public/
npm run start:server       # node dist-server/main.js
npm run db:migrate         # apply pending migrations (built bundle; used on deploy)
npm run db:migrate:dev     # same, straight from source, reads .env if present
npm run city:seed-demo -- --non-canonical       # install the NON-CANONICAL demo fixture (built bundle)
npm run city:seed-demo:dev -- --non-canonical   # same, straight from source
npm run city:genesis -- --help                  # canonical / rehearsal / replace-staging-fixture (built bundle)
npm run city:genesis:dev -- --help              # same, straight from source
npm run city:verify                             # read-only check of the installed city (built bundle)
npm run city:verify:dev                         # same, straight from source
npm run test:server
npm run test:e2e:server    # browser tests of the built app; needs TEST_DATABASE_URL
```

`npm run dev`, `build`, `test`, `test:e2e` and `lint` are unchanged: they still build and
test the local demo client, which is what rarecity.world serves.

`build:app` produces everything the service needs in `dist-server/`: the service bundles and,
under `public/`, a client built with `VITE_APP_MODE=server`. `start:server` serves that
client if it is there and is API-only if it is not. The start-up log line says which.

To run the whole thing locally:

```
npm run build:app
DATABASE_URL=postgres://… npm run db:migrate
DATABASE_URL=postgres://… npm run city:seed-demo -- --non-canonical
DATABASE_URL=postgres://… npm run start:server      # http://127.0.0.1:8787
```

## Railway

Railway no longer lets a new service use a `railway.json` / `railway.toml` file, so there is
none in this repository. The staging service's build, pre-deploy, start and health-check
configuration lives in its **Railway service settings**:

| Setting | Value on staging today (P0-D Slice 1) | Value this branch needs |
| --- | --- | --- |
| Build command | `npm run build:app` | unchanged |
| Pre-deploy command | `npm run db:migrate` | unchanged (applies migration `0004`: structure only, the city is not touched) |
| Start command | `npm run start:server` | unchanged |
| Health check path | `/ready` | unchanged |
| Variables | `APP_MODE=staging`, `DATABASE_URL=${{Postgres.DATABASE_URL}}`, `PUBLIC_ORIGIN=https://<the staging domain>`, `TRUSTED_PROXY=railway` | unchanged; optionally `HSTS_MAX_AGE`, `FRAME_ANCESTORS`, `ROBINHOOD_RPC_URL` |

`ACTIVATION_ENABLED` is not set anywhere. Deploying this build without it changes nothing a
visitor can do: both activation routes answer `403 activation_disabled`.

Without `PUBLIC_ORIGIN` or `TRUSTED_PROXY` this build refuses to start in staging, and
`db:migrate` refuses with it, so both have to be set before the branch is deployed. The
fixture city on staging was installed by hand once and is not touched by a deploy. The production service at rarecity.world has no repo-side
configuration and is not affected by anything here.

## Migrations

- Files are `server/migrations/NNNN_snake_case_name.sql`, numbered from `0001` with no gaps
  or repeats. A missing or duplicated number is an error before anything runs.
- Forward-only. Each migration runs once, inside its own transaction together with its
  `schema_migrations` row, so a failure leaves nothing behind. Do not put `BEGIN`/`COMMIT`
  in a migration; statements that cannot run in a transaction are not supported.
- Never edit an applied migration. Its checksum is recorded and verified on every run.
  Add a new file instead.
- Runs are serialized with a Postgres advisory lock, so concurrent deploys are safe.
- The runner never drops or truncates anything, and a test fails if a checked-in migration
  contains a destructive statement.
- After migrating, the database is stamped with its `APP_MODE` in `app_meta`. A database
  stamped `staging` refuses to be migrated or reported ready as `production` (and the
  reverse), which catches a process pointed at the wrong database.

## Tests

Database tests only ever use `TEST_DATABASE_URL`. They refuse to run if it equals
`DATABASE_URL` or if the database name does not end in `_test`. Each test works in its own
throwaway schema and drops only that schema.

```
docker run --rm -d --name rarecity-test-db -p 54329:5432 \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=rarecity_test postgres:17
export TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:54329/rarecity_test
npm run test:server
npm run test:e2e:server
```

Without `TEST_DATABASE_URL`, `test:server` skips its database suites and says so before the
run; `test:e2e:server` refuses to start.

## Boundaries

`src/game`, `src/config` and `src/protocol` are shared with the browser. Lint forbids them
from importing React, UI, transport or Node modules, and from touching browser globals. The
server reaches them only through `server/src/engine.ts`, is type-checked without DOM types,
and is forbidden from importing demo fixtures (seed city, demo player, demo-only commands).
The single exception is `fixtures/demoCity.ts`, which only the fixture command may import;
the demo seed is not in the bundle the service runs.

The client never verifies anything: it asks a wallet to sign the server's challenge and
shows what the server reports. It has no chain library and makes no RPC calls. The browser
wallet's selected account is displayed, and is never treated as who the visitor is.

viem is the service's only chain dependency. It is used for message construction,
signature recovery, ABI encoding and JSON-RPC, and stays external to the server bundle like
`pg`.
