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

- `requireActor` must govern every mutation, called with the session, world and player the page
  drew. Only the local rehearsal route calls it today (above); nothing outside local mode can change a city.
- **F5, a browser with no session.** A run token is a bearer token, and nothing in the current
  Core -> Play -> game contract ties a run to the browser that started it. A link carrying an
  attacker's run token, opened in a browser with no Rare City session, signs it in as the
  attacker (the page says who: "signed in as ..."). Closing this needs a contract change, for
  example: Play's `POST /v1/play/launch` accepts a `launchBinding`, a hash of a secret the
  launching browser holds for the game's origin, and returns it in the redeemed run; the game
  checks it against that secret before opening a session. Rare City cannot invent this on its own,
  because nothing the trusted issuer signs would vouch for it.

**Persistent gameplay foundation (P1-C2-B2A): built.** A world's city can hold properties
(migration 0007, `world_properties`; city state version 2), each one NFT on the exact plot a player
chose, written by `server/src/world/properties.ts` in one transaction with the city's next sequence
and its `world.property.activated` event. Every city answer carries the stored properties and a
read-only projection of each district (open wards, plot candidates), and `city:verify` replays
every activation through the engine.

**Local property rehearsal (P1-C2-B2B): LOCAL ONLY, NOT a production authorization.** The whole
player flow, on the standard city page: a launched player picks one of their TEST NFTs, a district
and a highlighted plot, reviews what is permanent, and activates a Tier 0 property; the page reads
the city again, warps to it and shows the stored record. `serve.ts` starts the server this way, and
`rehearsal.spec.ts` drives it.

- It exists only with `APP_MODE=local` AND `LOCAL_PROPERTY_REHEARSAL_FILE` (a JSON file
  `{ "kind": "rare-city/local-property-rehearsal-v1", "players": { "<discord user id>": ["<CAIP-19
  asset id>", …] } }`). Config refuses the file in any other mode; the app mounts no route without
  it (`GET /v1/play/rehearsal/assets` and `POST /v1/play/rehearsal/activations` are a plain `404` /
  `405`); the rehearsal module refuses to be built outside local mode; the property store refuses any
  mode or database but local; and the database itself refuses a world property in any database not
  stamped local (`world_properties_guard`), so no staging or production world city can advance.
- The file is test data, never ownership: no contract can say which NFTs a Proofy player holds. The
  page labels it everywhere (LOCAL REHEARSAL · TEST NFT). The browser names only one NFT the server
  lists for the session's player, and the server checks that again.
- An activation names the session, world and player the page drew; `requireActor` refuses anything
  else and asks Play afresh (no cache, no grace). It also needs an `Origin` header naming this
  server (beyond the common same-origin, JSON-only boundary), and is limited per session credential.
  The store then judges the NFT, the plot and the district under the city's lock. A district with a
  Proofy rule is refused (`district_rule_unverified`): nothing can check a rule yet.
- The same player repeating an activation gets the same property back (`fresh: false`); anyone else
  is refused with no session or player in the answer. A session ended during an activation is a typed
  refusal and nothing is written.
- Choosing the district by hand is REHEARSAL-ONLY test behavior, labelled as such on the page. On a
  live city a player's default district is assigned on authenticated, eligible city entry
  (citywide round-robin tickets, abandoned slots reused; matching collection/trait rules override
  it), and the player chooses only the exact plot. Not implemented yet.
- The owner's locked world policies apply to it (next section): the first property freezes the
  district geometry, and every property records its original activator.

Lifting the hold anywhere but local is a new migration replacing `world_properties_guard`, after
F5, F7, F3, a fresh Core NFT/role/verification eligibility contract and a separate non-owner database
runtime role exist. (Permanent activator provenance now exists: migration 0008.)

**Permanent world policies (P1-C2-B2C, migration 0008).** Owner-approved, locked decisions:

- **A. District geometry freezes at the first successful property, not at founding (implemented).**
  An empty city follows its governing configuration: an admin may change its district count, order
  and wedges by publishing a new Play version, and the world keeps its id. Each accepted version is
  recorded with the geometry it draws (`world_config_geometries`). The first successful activation
  writes `world_geometry_freezes` in its own transaction, under the city row lock that every
  configuration adoption also takes, so an adoption either governed that activation or comes after
  it. From then on every property must stand on that geometry and every governing version must draw
  it exactly (the launch refuses others with `config_incompatible`, and the database refuses such an
  adoption). Presentation changes and new collections still govern. A refused, failed or rolled-back
  activation freezes nothing. The founding record (`city.initialized`) is unchanged and stays the
  founding provenance. The configuration judge is now `world-evolution-v3`: a verdict depends on
  the document and the founding collections only; geometry is a governing rule. Verdicts recorded by
  `world-evolution-v2` are never re-judged: a version it rejected for moving districts stays
  rejected, and a corrected configuration is published as a new Play version. Worlds whose first
  property predates 0008 are recorded as frozen at their founding geometry (`frozen_by =
  'migration-0008'`), which is what 0007 enforced.
- **C. Original activator (implemented).** Each new property records the Core user id and Discord
  user id of the player of the activating play session (Play's redeemed run, as Proofy Core signed
  it), read from that session's locked row in the activation's transaction and checked again by the
  database against that row. Never browser-supplied, never changed, kept when sessions are tidied,
  and not the NFT's current holder. The same activator repeating an activation from any later
  session gets the same property back; anyone else, including the same Discord user under another
  Core user, is refused and told nothing about who placed it. A viewer is told only which properties
  they themselves activated (`viewer.originalActivations`). Properties written before 0008 have no
  recorded activator; for them the old rule (the activating session's row, while kept) still applies.
  Locally this identity comes from Play's dev Core issuer: it is NOT evidence that a production Core
  identity integration works.
- **B. Closing and re-opening a collection to new claims (NOT implemented: needs a Play contract
  change).** See below.

**Collection claim policy: the Play configuration change it needs.** Today Rare City's Play
configuration schema version 1 (`src/brand/core/playConfig.ts`) describes a collection as exactly
`{ key, chain, contract, displayName }` (`additionalProperties: false`), and Rare City's rules make
collections additive: a version that leaves out a collection the world has established cannot
govern it. So there is no way to say "keep this collection, but take no new claims from it", and
leaving it out of the document is refused, by design (it would read as deletion). The approved
behavior (the collection stays in the registry, existing properties stay valid and visible, closing
and re-opening are explicit and recorded as configuration versions) needs one explicit, required
field that Play stores and serves:

1. Rare City registers **configuration schema version 2** with Play (`PUT
   /v1/game/config-schemas/2`, Play contract 1.1.0 §4.3), identical to version 1 except that every
   collection object also REQUIRES `"claims": { "type": "string", "enum": ["open", "closed"] }`. No
   default: a version-2 document always states it. Play's existing immutable, numbered configuration
   versions are the history of every close and re-open.
2. What Play must authorize, which this repository cannot decide: that an installation's
   configuration versions may move from schema version 1 to 2 (runs already pin `schemaVersion`);
   that Play's admin configuration editor lets a server admin set `claims` on each collection; and
   that Play keeps serving version-1 runs while an installation still has them. Nothing else in Play
   changes: no new endpoint, field in the run, or Play-side meaning.
3. Then, in Rare City (a later slice): read schema 2 (`SUPPORTED_PLAY_SCHEMA_VERSIONS`), read every
   schema-1 document as all claims open, keep collections additive whatever `claims` says, refuse an
   activation of an NFT whose collection the governing version marks `closed`
   (`collection-claims-closed`, judged under the same city lock as geometry), keep every existing
   property valid against the version it was activated under, and verify that each property's
   collection was open in that version.

Until Play authorizes that change, no client-side or Rare City-only field stands in for it, and a
collection is never closed by removing it from a configuration.

Needs a verified Proofy Core / Play contract:

- **F3. Game status.** Play's installation answer does not include the game's status. While
  Play refuses launches for an inactive (`draft`) game, existing sessions still read the
  installation as active. (A retired game is caught: Play refuses Rare City's credential, F1.)
- **F7. Mid-session membership and entitlement.** Core checks Discord membership and the
  server's Play entitlement only when it signs the launch context. No Core or Play contract lets
  Rare City re-check either during a session, which is why the viewer reports both as verified
  at launch, never now.
