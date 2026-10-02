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

## Layout

```
server/
  src/
    main.ts            process entry: config, pool, client build, HTTP server, shutdown
    app.ts             HTTP routes
    http.ts            bounded JSON bodies, the session cookie, the same-origin rule
    static.ts          same-origin client: a fixed list of files loaded at start-up
    config.ts          environment → validated ServerConfig
    log.ts             JSON-lines logger
    engine.ts          the only doorway into src/game, src/config and src/protocol
    city/store.ts      the city: read side, and the one way a city is installed
    auth/service.ts    sign-in challenges, signature verification, sessions
    ownership/provider.ts     the OwnershipProvider interface
    ownership/generations.ts  Rare Friends on Robinhood Chain (the real adapter)
    ownership/fixture.ts      deterministic stand-in for local work and tests
    ownership/reader.ts       short-lived cache for the "My Friends" view
    fixtures/demoCity.ts   NON-CANONICAL demo city for staging and tests
    migrate-cli.ts     `npm run db:migrate`
    seed-demo-cli.ts   `npm run city:seed-demo -- --non-canonical`
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
attacker has to issue 20,000 in those few seconds. There is **no per-client rate limit
yet**: see "Not done yet" below.

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

**P0-D and P0-E must add every mutating route to the `posts` table in `app.ts`**, which
applies 1-3 and the 4 KiB body limit before the handler runs. A mutating route must not be
reachable any other way, and must not be a `GET`.

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

- **No per-client rate limiting.** It needs a decision on which proxy header to trust for
  the client address. Until then: a sustained flood of challenge requests can push real
  challenges out (see above); throwaway wallets can sign in freely and add `users`,
  `wallets` and `sessions` rows; and a few hundred signed-in throwaway wallets polling
  `/v1/viewer/friends` can keep the four discovery slots busy, so others see
  `ownership_unavailable`.
- **Smart-contract wallets** (EIP-1271) cannot sign in.
- **A signature can be relayed.** As with any Sign-In with Ethereum flow, a phishing site
  can fetch a challenge for a victim's address and, if the wallet does not warn that the
  message names another site, obtain a signature and a session. Today a session only shows
  public ownership. Before sessions can act (P0-D), consider binding sign-in to the
  browser that asked for the challenge.
- **No `Strict-Transport-Security`, `Content-Security-Policy` or `frame-ancestors`** header
  is sent with the app shell.
- **Log responses are size-limited only by the RPC provider.** The 50,000-log ceiling is
  applied after a response has been received.
- **One wallet per user.** The schema allows several; nothing links a second one yet.

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
transaction. Normalised tables (properties, ownership eras, ledgers) can be added beside
the snapshot and the snapshot kept as their projection.

## Genesis and the staging fixture

Two different things, kept apart:

- **Canonical genesis** is the real city's starting point: empty apart from civic
  infrastructure. Nothing installs it yet; it arrives with activation. Until then a
  production database has no city and `/v1/city` answers `city_not_initialized`.
- **The demo fixture** is the familiar 180-resident demo city. It is **NON-CANONICAL**:
  simulated residents, simulated RF, to be wiped before real RF. It exists so staging and
  tests have something to look at.

Nothing installs a city automatically: not a migration, not a deploy, not the service at
start-up. The fixture is installed only by running this by hand:

```
npm run city:seed-demo -- --non-canonical
```

It refuses to run without the flag, when `APP_MODE=production`, against a database stamped
for another environment, and once a city exists (it never overwrites one). Independently of
all code, a database stamped `production` rejects any non-canonical city row through a
trigger.

## Environment

| Variable | Used by | Notes |
| --- | --- | --- |
| `APP_MODE` | server | `local` (default), `staging` or `production`. A process with `NODE_ENV=production` must set it explicitly. |
| `DATABASE_URL` | server, `db:migrate`, `city:seed-demo` | `postgres://` URL. Optional in `local`, required otherwise. Never logged. |
| `PUBLIC_ORIGIN` | server | The one origin browsers reach this service at, e.g. `https://rarecity.example`. Written into sign-in messages and required of every `POST`. **Required, and must be `https://`, in `staging` and `production`.** In `local` it defaults to `http://<HOST>:<PORT>`. |
| `ROBINHOOD_RPC_URL` | server | Robinhood Chain RPC endpoint. Defaults to the public RPC. Must be `https://` in `staging` and `production`. May contain provider credentials: it is never logged or echoed. |
| `OWNERSHIP_PROVIDER` | server | `robinhood` (default) or `fixture`. `fixture` is refused unless `APP_MODE=local`. |
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

| Setting | Value on staging today (P0-B) | Value P0-C needs |
| --- | --- | --- |
| Build command | `npm run build:app` | unchanged |
| Pre-deploy command | `npm run db:migrate` | unchanged (applies migration `0003`) |
| Start command | `npm run start:server` | unchanged |
| Health check path | `/ready` | unchanged |
| Variables | `APP_MODE=staging`, `DATABASE_URL=${{Postgres.DATABASE_URL}}` | add `PUBLIC_ORIGIN=https://<the staging domain>`; optionally `ROBINHOOD_RPC_URL` |

Without `PUBLIC_ORIGIN` a P0-C build refuses to start in staging, so the variable has to be
set before the branch is deployed. The fixture city on staging was installed by hand once
and is not touched by a deploy. The production service at rarecity.world has no repo-side
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
