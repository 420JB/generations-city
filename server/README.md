# Rare City server

The production foundation for Rare City: one Node/TypeScript service and PostgreSQL, in the
same repository as the client. It reuses the deterministic rules in `src/game` and
`src/config` rather than reimplementing them.

This is a shell. It serves diagnostics only. There are no city reads, no mutation
endpoints, no wallet auth, no ownership checks and no real RF. The live demo at
rarecity.world does not use it.

## Layout

```
server/
  src/
    main.ts          process entry: config, pool, HTTP server, graceful shutdown
    app.ts           HTTP routes
    config.ts        environment → validated ServerConfig
    log.ts           JSON-lines logger
    engine.ts        the only doorway into src/game and src/config
    migrate-cli.ts   `npm run db:migrate`
    db/pool.ts       pg pool
    db/migrations.ts migration loader, runner and readiness probe
  migrations/        plain SQL, NNNN_snake_case_name.sql
  tests/
  railway.json       config for a separate Railway service (not the live one)
```

## Endpoints

| Route | Meaning |
| --- | --- |
| `GET /health` | Liveness. Always `200 {"status":"ok"}` while the process is up. Never touches the database. |
| `GET /ready` | Readiness. `200` when the database is reachable, fully migrated and stamped for this `APP_MODE`; otherwise `503` with the failing check. In local mode with no `DATABASE_URL` it is `200` with `"database":"not-configured"`. |
| `GET /version` | Service name, `APP_MODE` and the deployed commit. |

Anything else is `404`; any method other than `GET`/`HEAD` is `405`.

## Environment

| Variable | Used by | Notes |
| --- | --- | --- |
| `APP_MODE` | server | `local` (default), `staging` or `production`. A process with `NODE_ENV=production` must set it explicitly. |
| `DATABASE_URL` | server, `db:migrate` | `postgres://` URL. Optional in `local`, required otherwise. Never logged. |
| `PORT` | server | Default `8787`. |
| `HOST` | server | Default `127.0.0.1` in `local`, `0.0.0.0` otherwise. |
| `RAILWAY_GIT_COMMIT_SHA` / `GIT_SHA` | server | Reported by `/version`. |
| `TEST_DATABASE_URL` | tests | Disposable database; name must end in `_test`. |
| `REQUIRE_DB_TESTS` | tests | `1` turns a missing test database into a failure instead of a skip. |
| `VITE_APP_MODE` | client build | `local-demo` (default). `server` is reserved and not implemented. |

The demo client needs none of these. See `.env.example`.

## Scripts

```
npm run dev:server       # watch mode (tsx), reads .env if present
npm run typecheck:server
npm run build:server     # type-check, then bundle to dist-server/
npm run start:server     # node dist-server/main.js
npm run db:migrate       # apply pending migrations (built bundle; used on deploy)
npm run db:migrate:dev   # same, straight from source, reads .env if present
npm run test:server
```

`npm run dev`, `build`, `test`, `test:e2e` and `lint` are unchanged and still cover the client.

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

## Database tests

Database tests only ever use `TEST_DATABASE_URL`. They refuse to run if it equals
`DATABASE_URL` or if the database name does not end in `_test`. Each test works in its own
throwaway schema and drops only that schema.

```
docker run --rm -d --name rarecity-test-db -p 54329:5432 \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=rarecity_test postgres:17
TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:54329/rarecity_test npm run test:server
```

Without `TEST_DATABASE_URL` those tests are skipped and the run says so.

## Engine boundary

`src/game` and `src/config` are shared with the browser. Lint forbids them from importing
React, UI, transport or Node modules, and from touching browser globals. The server reaches
them only through `server/src/engine.ts`, is type-checked without DOM types, and is
forbidden from importing demo fixtures (seed city, demo player, demo-only commands).
