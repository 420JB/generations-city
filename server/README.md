# Rare City server

One Node/TypeScript service and PostgreSQL, in the same repository as the client. It holds
the shared city and serves it read-only. It reuses the deterministic rules in `src/game` and
`src/config` and the wire contract in `src/protocol` rather than reimplementing them.

What it does today:

- holds **one authoritative city** in Postgres, with a sequence that orders its changes;
- serves that city to anyone at `GET /v1/city` (every caller is an anonymous viewer);
- serves the built Rare City client from the same origin, when a client build is present.

What it does not do: no wallet auth, no ownership checks, no real RF, and **no mutations**.
Every route is `GET`/`HEAD`; no request body is ever read. The live demo at rarecity.world
does not use this service.

## Layout

```
server/
  src/
    main.ts            process entry: config, pool, client build, HTTP server, shutdown
    app.ts             HTTP routes
    static.ts          same-origin client: a fixed list of files loaded at start-up
    config.ts          environment → validated ServerConfig
    log.ts             JSON-lines logger
    engine.ts          the only doorway into src/game, src/config and src/protocol
    city/store.ts      the city: read side, and the one way a city is installed
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
| anything else | With a client build: the file at that path, or the app shell for a client route. Without one: `404`. |

`/health`, `/ready`, `/version` and everything under `/v1` belong to the service: an unknown
path there is a JSON `404` and is never answered with the app shell. A path whose last
segment has an extension and matches no file is a `404`, not the app shell. Any method other
than `GET`/`HEAD` is `405` on every path.

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
  "viewer": { "userId": null, "source": "anonymous" },
  "server": { "mode": "staging" },
  "state": { ...GameState }
}
```

- `If-None-Match` with the current ETag returns `304`. Responses are gzip-compressed on request.
- The viewer is always anonymous. No header or cookie can change that; there are no sessions yet.
- Errors are `503 {"error": <code>}` with `Retry-After: 5`:
  `city_not_initialized` (no city installed), `city_state_unsupported` (stored state has
  another `stateVersion`), `city_state_invalid` (stored state failed validation; none of it
  is served), `city_unavailable` (no database, or it failed).
- There is no events endpoint. The client needs the whole snapshot and revalidates it by ETag.

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

| Setting | Value on staging today (P0-A) | Value P0-B needs |
| --- | --- | --- |
| Build command | `npm run build:server` | `npm run build:app` |
| Pre-deploy command | `npm run db:migrate` | unchanged |
| Start command | `npm run start:server` | unchanged |
| Health check path | `/ready` | unchanged |
| Variables | `APP_MODE=staging`, `DATABASE_URL=${{Postgres.DATABASE_URL}}` | unchanged |

Installing the fixture on staging is a separate, manual step after the first P0-B deploy.
The production service at rarecity.world has no repo-side configuration and is not affected
by anything here.

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
