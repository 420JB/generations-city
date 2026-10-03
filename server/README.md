# Rare City server

One Node/TypeScript service and PostgreSQL, in the same repository as the client. It holds
the shared city and serves it read-only, and it knows who is looking. It reuses the
deterministic rules in `src/game` and `src/config` and the wire contracts in `src/protocol`
rather than reimplementing them.

What it does today:

- holds **one authoritative city** in Postgres, with a sequence that orders its changes;
- serves that city to anyone at `GET /v1/city`, signed in or not;
- lets a visitor **sign in with an EVM wallet** by signing a one-time challenge, and keeps
  a server session for them;
- reads, from Robinhood Chain, **which Rare Friends the signed-in wallet owns** and each
  one's canonical family;
- serves the built Rare City client from the same origin, when a client build is present.

What it does not do: **the city cannot be changed**. There is no property activation, no
gameplay command, no RF read or movement, and no transaction of any kind. The only requests
that change anything are the three sign-in `POST`s, and they change sessions, never the
city. The live demo at rarecity.world does not use this service.

The database is ready for permanent activation (migration `0004`: properties, ownership
eras, activation intents, append-only events) and an empty city can be installed by an
operator, but **no route, service or screen activates anything yet**. See "Activation
foundation" below.

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
| anything else | With a client build: the file at that path, or the app shell for a client route. Without one: `404`. |

`/health`, `/ready`, `/version` and everything under `/v1` belong to the service: an unknown
path there is a JSON `404` and is never answered with the app shell. A path whose last
segment has an extension and matches no file is a `404`, not the app shell. The three
`/v1/auth` routes accept only `POST` (`405`, `Allow: POST`); every other path accepts only
`GET`/`HEAD` (`405`, `Allow: GET, HEAD`).

Three routes are rate limited (see "Edge" below) and answer `429 {"error":"rate_limited"}`
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

A signed-in wallet is **not yet an actor in the city**. Nothing in the shared city can be
acted on, so the client keeps treating the city as read-only for everyone.

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
  "friends": [ { "tokenId": "812", "family": { "id": 2, "name": "Family" } } ] }
```

Token ids are decimal strings (uint256). The wallet is always the session's; nothing in the
request can name another, and no list of tokens is ever accepted from a browser.

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

- A key is always **who is asking**: the client network, or the user id from the session.
  It is never the address in a challenge request, a wallet being signed in, or a token id.
  A bucket keyed by something a request merely mentions could be emptied by anyone to lock
  the real owner out.
- The client limit runs before any database or chain work: on the sign-in routes before the
  body is read, on `/v1/viewer/friends` before the session is looked up. The user limit
  runs as soon as the session is known and before the ownership provider is asked.
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

A later slice that applies commands will lock the `city` row, apply the engine, write the
new state with `sequence + 1`, and append the matching `city_events` row, all in one
transaction.

## Activation foundation (migration 0004)

Structure, guards and operator tools. **Nothing here activates a Friend**: no route, no
service and no screen writes a property. Migration `0004` adds columns, tables and
triggers only; it does not touch an existing city's state, sequence, instance or events.

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
`wallets` row keeps its address and chain, and a `sessions` row keeps its user and wallet.
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
  chain to `4663` and the collection to Generations, the token id to `0 ..
  9007199254740991` (the city state holds a Friend id as a JavaScript number), the family
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
  status of `issued`, `committed` or `superseded`. An intent begins as `issued`, for a city
  that may hold properties, by one user through their own wallet and a session of theirs.
  At most one `issued` intent per wallet and Friend. `committed` requires a time before
  the intent expires, a 65-byte signature and the property, and the property must be the
  one that names this intent. **Signed fields can never change.** The
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
- that a token id arrives as a whole number: Postgres rounds `1.5` on its way into a
  `numeric(78,0)`, so the service must refuse anything that is not a canonical decimal
  before it reaches the database;
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
not limit a user to one Friend, and grants no control over a property. Who may act will
come from the session, a fresh ownership read from the chain, and `properties` /
`ownership_eras`. (`DemoUser` remains as an alias of the same shape for the demo code; the
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
