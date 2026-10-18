# Rare City on a local Proofy Play

The Proofy Play launch page (`proofy-city-play/`) is Rare City's registered launch URL. Play
sends a player there with a run token in the fragment (`#runToken=…`). The page posts it to
the Rare City server (`POST /v1/play/session`), which redeems it with Play using Rare City's
service credential, loads the configuration version the run was pinned to, checks it against
the run (installation, server, version, hash), validates it, and returns it. The page draws it
with the standard renderer. The browser never names an installation.

That launch also opens a **play session**: an HttpOnly, SameSite=Strict cookie for this origin
(`rc_play`; `__Host-rc_play` outside local mode) naming the player Play's redeemed run named and
the city the launch opened (`play_sessions`, migration 0006; only the cookie value's SHA-256 is
stored). With it a reload or a new tab reads the city again from `GET /v1/play/city` without
another launch, and `POST /v1/play/logout` ends it. A session ends with Play's run (Rare City's
registered `maxRunSeconds`, at most 12 hours), on logout, on a newer launch by the same player in
the same browser, and when Play gives a definite no (the installation no longer active, or Rare
City itself refused). A launch for another player never replaces it (see below). It is never renewed: launching again
from Proofy Play is how a player is re-authorized. See `server/src/play/session.ts`.

Proofy Core's context-token issuer is not deployed, so locally Core is stood in for by Play's
own dev issuer key. Everything else is the real Play service and contract (1.1.0).

## 1. A local Proofy Play (outside this repository)

Use a copy, not the Play checkout itself (building writes into the tree). Node 24.

```sh
git -C ~/workspace/proofy-play-catalog archive HEAD | tar -x -C /path/to/play-copy
cd /path/to/play-copy && npm ci && npm run build
npm run -s dev:keys -w @proofy/play-api > play.env      # then point DATABASE_URL at a disposable Postgres
echo PORT=18090 >> play.env; echo HOST=127.0.0.1 >> play.env
set -a; . ./play.env; set +a
npm run db:migrate && node apps/api/dist/server.js
```

## 2. Environment for Rare City's side

From `play.env`:

```sh
export PLAY_API_URL=http://127.0.0.1:18090
export PLAY_DEV_OPERATOR_KEY=$DEV_OPERATOR_KEY
export PLAY_DEV_CORE_ISSUER_PRIVATE_KEY=$DEV_CORE_ISSUER_PRIVATE_KEY
export PLAY_DEV_CORE_ISSUER_KEY_ID=$DEV_CORE_ISSUER_KEY_ID
# A disposable Postgres database whose name ends in _test. Each installation's first launch
# founds its persistent city here; worlds are permanent, so use a database you can drop.
export CITY_PLAY_DATABASE_URL=postgres://localhost:5432/rarecity_city_play_test
```

## 3. Run it

Browser tests (they start everything below themselves):

```sh
npm run test:e2e:city-play
```

By hand:

```sh
node_modules/.bin/tsx e2e-city-play/serve.ts     # registers the game, mints a credential, registers the schema, starts the server on :4351
npm run dev:city-play                            # the launch page on http://localhost:4352/
```

Then install Rare City on a Discord server, publish a configuration and launch, with the
helpers in `play.ts` (`install`, `publish`, `launch`, `launchHref`), and open the printed
`http://localhost:4352/#runToken=…`. Each launch opens once; launch again for a new one.

## For a deployment

The server reads `PLAY_API_URL`, `PLAY_SERVICE_CREDENTIAL` and optionally `PLAY_GAME_KEY`
(default `rare-city`), and needs `DATABASE_URL` with them: a launch opens the installation's
persistent city (migration 0005 must be applied). The credential's Play environment must match `APP_MODE`
(local → dev/test, staging → staging, production → live). Register the schema once per Play
environment with `npm run play:register-schema`.

**Play sessions are NOT authorized for live deployment.** They allow read-only viewing only: the
server answers every session with `permissions: { viewCity: true, claim: false, build: false }`,
no route accepts a play session for any change to a city, and the page refuses a viewer that
says otherwise. An independent security audit (2026-10-17) passed this slice for a feature-branch
checkpoint and listed seven gates; the hardening slice (C2-B1H) addressed those Rare City can
close on its own. Status:

| Gate | Status |
| --- | --- |
| F1 a definite refusal from Play read as "unknown" | fixed |
| F2 "unknown" with no freshness bound | fixed (policy below) |
| F4 duplicate Play checks, timeouts not cancelled | fixed |
| F5 login CSRF | fixed for a signed-in browser; **open for a browser with no session** (needs a Core/Play contract, below) |
| F6 a stale tab acting as another player or in another world | fixed for any future action that uses `requireActor`; no action exists yet |
| F3 game status | **open**: not in Play's installation contract |
| F7 mid-session membership and entitlement | **open**: no Core or Play contract |

**Play's authority on every read** (`server/src/play/installationCheck.ts`, `session.ts`). Each
city read asks Play whether the installation is still active, sharing one request per installation
between simultaneous reads, and aborting it at `INSTALLATION_CHECK_MS` (3 s).

- `active` (asked now, or reused for `INSTALLATION_CHECK_CACHE_MS`, 15 s): the city is served.
- A definite no ends the session for good (revoked, cookie cleared, 403): the installation
  suspended, uninstalled, not shown (`installation_not_found`) or not this one
  (`installation_not_active`); or Play refusing Rare City itself, `401` (credential revoked or
  expired, game retired) or any other `403` (`play_authorization_refused`). A refusal of Rare City
  voids every installation's cached and grace readings, and an "active" that was asked before a
  definite no is never used after it.
- No authoritative answer (unreachable, timed out, malformed): the city is still served,
  `installationActive: unknown`, for at most `PLAY_SESSION_GRACE_MS` (60 s) after Play's last
  `active` for that installation in this process. A launch's own check counts, timed from when
  it was asked. Past that, or in a process that has no such reading (after a restart), the read is
  refused for now (503 `installation_unverified`, `Retry-After`): the session and its cookie are
  kept, and it serves again once Play answers `active`.
- The grace period and the cache are for viewing only. Anything that acts for a player must call
  `requireActor`, which asks Play afresh and accepts only `active`.

**Who is acting** (F5, F6). A launch never changes which player a browser is signed in as: a run
for another player than the browser's live session opens nothing (409 `play_session_other_player`)
and the session is kept. The conflicting run token is spent, because Play redeems once: the link
cannot be used again, in this browser or any other. The same player launching again replaces their
own session. To switch players, sign out, then start a NEW launch from Proofy Play as the other
player.
Every city answer names its session (`viewer.session.ref`, an identifier that authorizes
nothing), and `requireActor(cookie, { sessionRef, worldId, discordUserId })` refuses
(409 `play_actor_mismatch`) unless the browser's live session is exactly the one the page drew.
The page also tells other tabs of the browser when it launches or signs out, and a tab showing
another session stops presenting it as current.

Required before any player mutation (claim, build, economy):

- `requireActor` must govern every future mutation, called with the session, world and player
  the page drew. Nothing calls it yet: no route lets a play session change anything.
- **F5, a browser with no session.** A run token is a bearer token, and nothing in the current
  Core -> Play -> game contract ties a run to the browser that started it. A link carrying an
  attacker's run token, opened in a browser with no Rare City session, signs it in as the
  attacker (the page says who: "signed in as ..."). Closing this needs a contract change, for
  example: Play's `POST /v1/play/launch` accepts a `launchBinding`, a hash of a secret the
  launching browser holds for the game's origin, and returns it in the redeemed run; the game
  checks it against that secret before opening a session. Rare City cannot invent this on its own,
  because nothing the trusted issuer signs would vouch for it.

Needs a verified Proofy Core / Play contract:

- **F3. Game status.** Play's installation answer does not include the game's status. While
  Play refuses launches for an inactive (`draft`) game, existing sessions still read the
  installation as active. (A retired game is caught: Play refuses Rare City's credential, F1.)
- **F7. Mid-session membership and entitlement.** Core checks Discord membership and the
  server's Play entitlement only when it signs the launch context. No Core or Play contract lets
  Rare City re-check either during a session, which is why the viewer reports both as verified
  at launch, never now.
