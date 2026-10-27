# Districts hosted preview (LOCAL_HOSTED_PREVIEW)

A private, internet-reachable preview of the Districts Play game: the real Play client, served by the
Districts server itself, over a fresh, isolated database, with synthetic NFTs, synthetic controllers and
valueless TEST credits. Testers can claim a property and choose its exact plot, build Tier 0 to 2 as its
owner or a patron, customize it in all six Architect categories, and read the Architect Portfolio and
Property Legacy. Their progress survives reloads and restarts.

**This is NOT a production authorization.** There are no real wallets, no real currency and no rewards.
There is no production identity, and no real NFT is touched. The game routes are the LOCAL PROPERTY
REHEARSAL's (`e2e-city-play/README.md`). The profile makes it safe to expose those routes behind a gate.
It does not make them production routes.

Nothing in this directory deploys anything. The Railway steps below are a proposal (see "Proposed Railway
architecture") and still need an independent audit and the owner's approval.

## Security model

`LOCAL_HOSTED_PREVIEW=true` is a **profile of `APP_MODE=local`**, not a new mode. It has to be local mode:
the rehearsal's guarded writes exist only there, on a database stamped `local`. A dedicated mode would need
its own audited design.

**A database stamped `local` does not make an internet-facing process safe.** The profile's own rules do
that, and none of them depends on the stamp:

1. **Fail-closed configuration** (`server/src/config.ts`, `readHostedPreview`). Start-up refuses every
   missing or contradictory setting (see "Refusal matrix" below).
2. **The access gate** (`server/src/previewGate.ts`). HTTP Basic authentication is checked before any
   route, on the same decoded path the router uses next. Only `GET`/`HEAD` on `/health` and `/ready` are
   public. Everything else is gated, for every method: the HTML, `/assets/*`, `/brand-media/*`, every
   `/v1` route, the client-side fallback, unknown paths, `/version`, `OPTIONS`.
   - Only the password's SHA-256 is configured. The password itself is refused as configuration.
   - The user name and the password are always both compared, in constant time.
   - The base64 encoding must be canonical. Credentials are never logged or echoed, and never go in a URL.
   - A missing credential and a wrong one get the same 401 with `WWW-Authenticate`, `no-store` and no
     body detail.
   - Wrong credentials are rate-limited per client network: 20/min and 120/h, keyed by Railway's
     `X-Real-IP`. A correct credential and a first visit are never counted.
   - The gate is **never game authority**. It never sets or reads a cookie. Every game read and write
     still needs the Proofy Play session (`__Host-rc_play`), and `requireActor` still asks Play afresh
     before each write.
3. **Deployed transport rules in local mode** (`secureTransport`):
   - `__Host-` `Secure` `HttpOnly` `SameSite=Strict` `Path=/` session cookies.
   - HSTS, one year by default (`HSTS_MAX_AGE` must be greater than 0).
   - `upgrade-insecure-requests` and the existing strict CSP (`script-src 'self'`, `style-src 'self'`,
     `connect-src 'self'`, `frame-ancestors 'self'`).
   - The existing Origin and `Sec-Fetch-Site` CSRF rule on every POST, plus the rehearsal routes' own
     Origin check.
   - Proxy trust is `TRUSTED_PROXY=railway`: `X-Real-IP` only, and `X-Forwarded-For` is never read.
   - Rate limits are on.
4. **Private caching.** Gated static files are sent `private`, never `public`, so no shared cache may
   keep a copy of a response to a request that carried credentials. API answers stay `no-store`.
5. **No wallet surface.** In a preview, wallet sign-in, the owned-Friends read and Friend activation are
   not wired at all, whatever the process built (`app.ts`). Their routes answer `auth_unavailable`,
   anonymous and `activation_disabled`, and no chain RPC is ever made.
6. **Start-up database check** (`server/src/preview.ts`). The service refuses to start unless the
   database is reachable, fully migrated and stamped `local`. A staging or production database is never
   served. It also refuses to start without the built Play client (`dist-server/play`).

Unchanged: ordinary local mode (loopback, plain http, no gate), staging and production. Two new refusals
protect against a forgotten flag:

- A gate variable set without `LOCAL_HOSTED_PREVIEW=true` stops start-up.
- `APP_MODE=local` on Railway without the profile stops start-up. Railway is detected by
  `RAILWAY_ENVIRONMENT_ID`, `RAILWAY_PROJECT_ID` or `RAILWAY_SERVICE_ID`.

## Environment

| Variable | Value |
| --- | --- |
| `LOCAL_HOSTED_PREVIEW` | `true` (exactly) |
| `APP_MODE` | `local` (stated, never defaulted) |
| `NODE_ENV` | `production` |
| `PUBLIC_ORIGIN` | the preview's `https://` origin, e.g. `https://districts-preview-xxxx.up.railway.app` |
| `TRUSTED_PROXY` | `railway` |
| `DATABASE_URL` | the preview's OWN fresh Postgres (reference variable) |
| `PLAY_API_URL` | a DEV/TEST Proofy Play: `https://…`, or `http://<service>.railway.internal:<port>` |
| `PLAY_SERVICE_CREDENTIAL` | `ppk_dev_…` or `ppk_test_…` minted by that Play's operator (secret) |
| `LOCAL_PROPERTY_REHEARSAL_FILE` | `hosted-preview/rehearsal-controller-a.json` (or `-b`) |
| `PREVIEW_ACCESS_USER` | e.g. `preview` |
| `PREVIEW_ACCESS_PASSWORD_SHA256` | SHA-256 (hex) of a generated password (secret) |
| `HOST`, `PORT`, `HSTS_MAX_AGE` | optional. The defaults are `0.0.0.0`, the platform's `PORT` and one year |

Generate the gate password once, give it to testers out of band, and store only its hash:

```sh
PASSWORD=$(openssl rand -base64 32)            # share with testers through a password manager
printf %s "$PASSWORD" | shasum -a 256 | cut -d' ' -f1   # -> PREVIEW_ACCESS_PASSWORD_SHA256
```

Never set `OWNERSHIP_PROVIDER=fixture`, `RATE_LIMITS=off`, `ACTIVATION_ENABLED=true`, `FRAME_ANCESTORS`
or `PREVIEW_ACCESS_PASSWORD`. Each one stops start-up.

### Refusal matrix

| Configuration | Result |
| --- | --- |
| complete profile above | starts; gate on; `__Host-` Secure cookies; HSTS; CSP + upgrade-insecure-requests |
| `LOCAL_HOSTED_PREVIEW` not exactly `true`/`false` | refused |
| gate variables without `LOCAL_HOSTED_PREVIEW=true` | refused |
| `APP_MODE=local` (or unset) on Railway without the profile | refused |
| `APP_MODE` unset, `staging` or `production` with the profile | refused |
| `PUBLIC_ORIGIN` unset or `http://` | refused |
| `TRUSTED_PROXY` unset or `none` | refused |
| `RATE_LIMITS=off` | refused |
| `HSTS_MAX_AGE=0` | refused |
| `FRAME_ANCESTORS` set | refused |
| `ACTIVATION_ENABLED=true` | refused |
| `OWNERSHIP_PROVIDER=fixture` (legacy wallet fixtures) | refused |
| no Play, or a `ppk_staging_`/`ppk_live_` credential | refused |
| `PLAY_API_URL=http://` to a public host | refused (https, `*.railway.internal` or loopback only) |
| no `LOCAL_PROPERTY_REHEARSAL_FILE`, or no `DATABASE_URL` | refused |
| `PREVIEW_ACCESS_USER` or `…_SHA256` missing, malformed, or the hash of `""` | refused |
| `PREVIEW_ACCESS_PASSWORD` (plaintext) set | refused |
| database unreachable, not fully migrated, or stamped staging/production | start-up exits 1 |
| `dist-server/play` missing | start-up exits 1 |

`server/tests/hostedPreview.config.test.ts` covers each row. It also checks that ordinary local,
staging and production configurations come out as before.

## Build and start

```sh
npm ci
npm run build:preview        # server bundle + the Districts Play client into dist-server/play (no Vite server at run time)
npm run db:migrate           # pre-deploy: migrates and stamps the fresh database local; reads the same env
npm run play:register-schema # once per Play environment
npm run start:server         # node dist-server/main.js
```

The server serves `dist-server/play` (the existing `proofy-city-play` entry and `PlayCityApp`, built by
Vite with no other changes) from the same origin as the API. The page and every API call are
same-origin, under the existing CSP. The ordinary build (`npm run build:app` → `dist-server/public`) is
untouched and is not served in a preview.

## Synthetic preview world

Everything here is made up and public-safe:

- example contracts `0x…d101` and `0x…d102`;
- Discord ids in the `9100000000000…` range;
- no URLs, wallets or secrets.

`server/tests/hostedPreview.fixture.test.ts` checks this.

- `districts-preview.config.json`: the Play configuration the preview's admin publishes. "Preview
  Harbor" has two collections (Preview Keepers, Preview Pass) and four unrestricted districts, so the
  round-robin district ticket rotation assigns every claim.
- `rehearsal-controller-a.json` / `-b.json`: the rehearsal file (v4) for Discord server
  `910000000000000001`.

| Player (Discord id) | Test NFTs | Controls (variant a) | Controls (variant b) | TEST credits |
| --- | --- | --- | --- | --- |
| Ada `910000000000000101` | Keepers #101, #102; Pass #201 | Keepers #101 | (none) | 400 |
| Bea `910000000000000102` | Keepers #103; Pass #202 | Keepers #103 | Keepers #101, #103 | 300 |
| Cy `910000000000000103` | Keepers #104 | Keepers #104 | Keepers #104 | 200 |

Tier 1 is 100 lifetime units and Tier 2 is 250 (each step is 50). An owner can reach Tier 2 alone, and
patrons can help. The file is read once at start-up. Nothing resets or reseeds the database on start-up,
and there is no public reset, seed, migration, fixture-editing, controller-switching or credit route.

### Controller transfer (operator procedure, restart only)

1. Ada claims Keepers #101 and builds or designs on it under variant `a`.
2. The operator changes `LOCAL_PROPERTY_REHEARSAL_FILE` to `hosted-preview/rehearsal-controller-b.json`
   and restarts the service. On Railway that is a variable change, which redeploys.
3. Bea is now its named controller and may build as its owner and save designs. Ada keeps:
   - her founding;
   - her owner units, as an earlier controller's;
   - her design revisions;
   - her portfolio entry, under "earlier control".

The procedure is reversible the same way. It is local TEST control, never verified ownership.

## Proofy Play requirements (DEV/TEST)

The preview uses the existing Play contract (1.1.0) unchanged. A hosted DEV or TEST Proofy Play has to
provide:

- **Game identity.** The game `rare-city` (`PLAY_GAME_KEY`, default) is registered by Play's operator:
  `status: active`, `maxAuthority`/`minAcceptAuthority: server_authoritative`, and `launchUrl` = the
  preview's `PUBLIC_ORIGIN` + `/`.
- **Installation identity.** An installation of `rare-city` on the synthetic Discord server
  `910000000000000001` (the fixture's guild), created by that server's admin through Play's admin
  routes.
- **Configuration.** The schema is registered with `npm run play:register-schema`, as schema version 1.
  `districts-preview.config.json` is published and activated as a configuration version. Each launch
  pins a config version and hash. Rare City reads that version and checks installation, server, version
  and hash against the run (`config_binding_mismatch` otherwise). It records the version in the world's
  binding (`world_play_bindings`: Play environment, game key, installation, guild).
- **Service credential.** `PLAY_SERVICE_CREDENTIAL` is a `ppk_dev_`/`ppk_test_` credential minted by the
  operator for `rare-city`. Rare City uses it as a bearer for these calls:
  - `POST /v1/game/runs/redeem`
  - `GET /v1/game/installations/{id}`
  - `GET /v1/game/installations/{id}/config/{version}`
  - `PUT /v1/game/config-schemas/1`
- **Player identity.** A run names a Discord user, a Core user id and a display name, from a Core context
  token. Core's issuer is not deployed, so a DEV Play verifies tokens from its dev stand-in issuer key.
  Whoever launches testers mints those tokens. With that key, the synthetic ids above are the players.
- **Browser launch flow.**
  1. Play answers a launch with `launchUrl#runToken=…`.
  2. The browser opens it. The gate challenges, and the tester enters the preview credential once per
     browser session. The fragment survives the challenge.
  3. The page takes the run token out of the address bar and history, and POSTs it to
     `/v1/play/session` on the same origin.
  4. The server redeems it once, so the link dies, and opens the installation's persistent city.
- **Session cookie lifecycle.** `__Host-rc_play` (`Secure; HttpOnly; SameSite=Strict; Path=/`). Only its
  SHA-256 is stored. It lasts as long as Play's run, at most 12 hours. It ends on logout, on a newer
  launch by the same player, or on a definite no from Play. It is never renewed: launch again from Play.
  A launch for another player never replaces it (409).
- **Network.** The Districts server must reach Play over https, or over Railway's private network
  (`http://<play>.railway.internal:<port>`). Play's own launch and admin routes must be reachable by
  whoever installs, publishes and launches.

Whether a hosted DEV Proofy Play instance exists is **not verified**. Without one, the preview can be
built and started, but no launch can open a city.

## Running the preview locally (headless browser tests)

`e2e-hosted-preview/` runs the exact profile on one machine:

- the built server (`node dist-server/main.js`) with `LOCAL_HOSTED_PREVIEW=true`;
- the committed synthetic world;
- a TLS stand-in for Railway's edge (`edge.ts`: a throwaway self-signed certificate, with `X-Real-IP`
  overwritten), at `https://localhost:4453`;
- a local Proofy Play (`e2e-city-play/README.md`, steps 1-2);
- a fresh `PREVIEW_DATABASE_URL` (`*_test`).

```sh
# empty preview and Play databases first; then:
PREVIEW_PHASE=founding npx playwright test --config e2e-hosted-preview/playwright.config.ts
# restart Postgres if you like, then (same databases, variant b):
PREVIEW_PHASE=transfer npx playwright test --config e2e-hosted-preview/playwright.config.ts
```

## Proposed Railway architecture (not created)

A **separate Railway project**, `districts-preview`, sharing nothing with Rare City's production or
staging projects, their databases or their variables:

- `districts-preview-server`: this repository at a reviewed commit, on a dedicated branch that nothing
  else deploys, with PR deploys off.
  - Build `npm ci && npm run build:preview`.
  - Pre-deploy `npm run db:migrate`.
  - Start `npm run start:server`.
  - Healthcheck `/ready`.
  - The variables above. `DATABASE_URL` references only the project's own Postgres.
  - A Railway domain, or a custom domain, as `PUBLIC_ORIGIN`.
- `districts-preview-postgres`: a fresh Railway Postgres for this project only. It is never restored
  from staging or production.
- `proofy-play-dev` (from the Proofy Play repository, separately reviewed): its own Postgres, DEV keys,
  and private networking to the server.
- Optional: Railway's edge authentication, as an extra layer in front of the app gate. Whether the
  workspace is entitled to it is unknown.

## Must be independently audited before any deployment

- The gate's placement in front of all routing. Path decoding parity, methods, Node's own 400s.
- Basic-auth parsing and the constant-time comparisons. The decision to use a plain SHA-256 of a
  generated secret, rather than a slow hash.
- The refusal matrix, and the Railway-marker refusal of plain local mode.
- That Railway's edge overwrites a client-sent `X-Real-IP`. This is **still unproven on Railway**: the
  local edge stand-in assumes it. If it does not, the failure limiter can be spread across buckets, but
  the gate itself does not depend on it.
- That wallet, activation and fixture-ownership paths are unreachable in a preview.
- Private caching of gated files through Railway's edge.
- The rehearsal routes' exposure to authenticated testers: they were built for one local machine, and
  their limits are per client network and per play session.
- The open Play gates (F3, F5, F7 in `e2e-city-play/README.md`). For example, a run-token link opened in a
  browser with no session signs that browser in as the token's player.
- Synthetic fixture content and the controller-transfer procedure.
