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

**Local property rehearsal (P1-C2-B2B, district tickets P1-C2-D1): LOCAL ONLY, NOT a production
authorization.** The whole player flow, on the standard city page: a launched player is ASSIGNED a
district by the server on entry (a district ticket, below), picks one of their TEST NFTs and a
highlighted plot in that district, reviews what is permanent, and activates a Tier 0 property; the
page reads the city again, warps to it and shows the stored record. `serve.ts` starts the server this
way, and `rehearsal.spec.ts`, `tickets.spec.ts`, `world-policy.spec.ts`, `claim-experience.spec.ts` and `property-home.spec.ts` drive it.

- It exists only with `APP_MODE=local` AND `LOCAL_PROPERTY_REHEARSAL_FILE` (a JSON file
  `{ "kind": "rare-city/local-property-rehearsal-v1", "players": { "<discord user id>": ["<CAIP-19
  asset id>", …] } }`, or version 2, below). Config refuses the file in any other mode; the app
  mounts no route without it (`GET /v1/play/rehearsal/assets`, `GET …/ticket` and the POST routes
  `…/entry`, `…/assignment`, `…/release`, `…/activations` are a plain `404` / `405`); the rehearsal
  module refuses to be built outside local mode; the ticket and property stores refuse any mode or
  database but local; and the database itself refuses a ticket, slot, rotation or world property in
  any database not stamped local (0007, 0010), so no staging or production world city can advance.
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
- The player never chooses a district (owner-locked, MCD 46B). The server assigns it on entry from
  the city's citywide round-robin rotation, or from an explicit district rule for the NFT they
  select, and the player chooses only the exact plot inside it. The manual district choice of
  P1-C2-B2B is gone.
- The owner's locked world policies apply to it (next section): the first property freezes the
  district geometry, and every property records its original activator.
- **The player's claim (P1-C2-E1), presentation only.** A claim card in the bar names the assigned
  district (its color, and whether the rotation or a district rule assigned it), counts down the claim
  window and says the next step; the plot panel shows the same countdown, four steps (test NFT,
  district, plot, activate) and each refusal under what it asks of the player (try again, a fresh
  claim, not allowed, the city's administrator, another plot). The countdown's only authority is the
  ticket's `expiresAt`, the end of the database's 900-second claim window: the page starts, stores and
  extends nothing (a reload, another tab, an NFT switch or leaving and entering again read the same
  end), corrects only its own clock from the server's `Date` header, stops offering activation at zero
  and asks the server (`GET …/ticket`) whether the claim ended. No route, ticket rule or policy changed;
  L1 is still the owner's to decide. `claim-experience.spec.ts` drives it; where it needs time to pass
  it moves the claim window in the disposable database (`claimWindow.ts`, the server tests' replica-role
  technique), so CITY_PLAY_DATABASE_URL's role must be allowed to set `session_replication_role`.
- **The player's property home (P1-C2-E2), presentation only.** MY PROPERTIES in the HUD lists the
  properties the session's player FOUNDED in this city: `viewer.originalActivations` (the server's
  permanent activator record, matched on the session's Proofy identity, scoped to this world) applied
  to the stored `world.state`. No new route, migration or write: nothing the page sends selects whose
  list it is. Each property shows its NFT, district, exact Ward/Plot, founding order and city
  sequence, and WARP opens its panel and flies the camera there. A stored property's panel keeps
  "Founded by" (you / recorded privately / not recorded) apart from "Current holder: Not verified"
  (who holds an NFT now is not known to Rare City), counts the properties of its district and city
  from the stored state, lists its nearest neighbours with WARP, and says construction is coming later
  in place of the preview build (no progress bar, build, spend or unlock). `property-home.spec.ts`
  drives it.

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

**World-policy hardening (P1-C2-B2C-H, migration 0009).** Corrections from the independent C2-B2C
audit:

- **The plot is placed on the ground the player chose it on.** A plot id names ground only on one
  geometry: before the first property an adoption can redraw the districts under the same ids
  (`tidewater-w0-p0` was −45°/90° on four districts and −75°/60° on six). So an activation carries the
  layout geometry fingerprint of the city its page drew (`PlayWorld.definition.geometryFingerprint`,
  shape-checked at the route), and under the city lock it must be the governing geometry's, or it is
  refused `409 config_superseded` before anything is written. The page reads the city again, drops
  the selected plot on a redrawn map and asks the player to choose again.
- **The first property waits for Play's active configuration.** Adoption follows a launch, so a city
  can still be governed by version 1 after an admin activated version 2. The first property would
  freeze version 1 for good, decided by launch order. So, for a city's first property only, with the
  city lock held, Rare City asks Play once more which version the installation has active (contract
  1.1.0 §4.4, `GET /v1/game/installations/{id}`: `activeConfigVersion`, `activeConfigHash`, the
  installation's pointer, §7) and refuses `409 config_superseded` unless it is exactly the governing
  version and hash; the page says to launch again, which adopts it. No answer within 3 s, or an
  installation not active, refuses it (`503 installation_unverified`): a first property is never
  written on an uncertain configuration. A publish Play accepts after it answered comes after the
  property, and must then draw the frozen geometry to govern, like any later publish.
- **An older build cannot record a new verdict (0009).** A new `world_config_versions` row must be
  judged by the current judge (`world-evolution-v3`); an older instance left running after 0008 has
  its launches refused rather than recording a v2 verdict for good. Recorded verdicts are untouched.
  Older instances must still be stopped before migrating (`server/README.md`, Migrations).
- **Unknown stays unknown.** A property written before 0008 has no recorded activator; the page says
  so (`viewer.unrecordedActivations`) instead of implying a private record exists.

**District tickets (P1-C2-D1, migration 0010): the locked default assignment, LOCAL ONLY.** MCD 46A
and 46B (owner-locked 2026-10-15, amended 2026-10-16), implemented for the local rehearsal only:

- **Entry.** A launch from Proofy Play is the player's city entry: the page asks the server for a
  district (`POST /v1/play/rehearsal/entry`, the exact session, world and player the page drew;
  `requireActor`, Play active now). The server issues one only if the rehearsal file lists an
  unplaced NFT of this city for the session's player (`403 not_eligible` otherwise: no ticket). An
  anonymous view, a generic sign-in, a reload or a new tab never issue one: a reload only reads the
  ticket held (`GET …/ticket`). A player who holds an active ticket gets that same ticket back from
  every entry, relaunch, tab or session (one active ticket per player per world, a database unique
  index), so nobody skips a district or hoards slots by logging in again. After a property is
  placed, "Get your district" is the next claim: a new, independently checked ticket.
- **Rotation.** One per world, shared by every collection: the governing configuration's UNRESTRICTED
  districts (no Proofy rule) in configuration order (owner-locked, policy D1). Slot ordinal `n` names `districts[(n - epoch start) mod length]`. A, B and C entering in
  that order hold districts 1, 2 and 3 at the same time, without waiting, and may place in any order.
- **Gap reuse.** A ticket ends exactly once: released by its holder (`POST …/release`, the panel's
  "Leave · release my district"), expired server-side by the database's clock (no browser unload is
  needed or trusted), superseded by a rotation change, or committed by the activation that consumed
  it. A released, expired or superseded fallback slot returns to the gap pool in the same
  transaction, and the next entrant receives the LOWEST free ordinal before any new one, at the slot's
  next GENERATION, as a new ticket id. A page still naming the old ticket cannot commit
  (`ticket_not_live` / `ticket_expired`). The high-water mark (ordinals ever issued) and the committed
  count are separate numbers.
- **Lease (policy D2, locked 2026-10-21; migration 0011).** A player's CLAIM WINDOW in a world
  opens with the first ticket issued to them and lasts EXACTLY 900 seconds, set by the database's
  clock (`world_claim_windows`; the window guard overwrites whatever a caller asks for). Every
  ticket issued to them while it is open ends exactly when it ends: a reload, relaunch or other tab
  gets the same ticket; an NFT switch, leaving and entering again, or a reissue after a rotation
  change gets a new ticket with the SAME end. Nothing renews it. It closes when one of its tickets
  becomes a property (the next NFT then opens a new window, without signing out) or once it has run
  out (a fresh claim then opens a new window: no lockout beyond the window the player opened).
  `LOCAL_DISTRICT_TICKET_TTL_SECONDS` no longer exists: the server refuses to start with it set to
  anything but `900`. A switch or re-entry whose window runs out while it is being written is
  refused `ticket_expired`, and nothing changes. A lease issued before 0011 (0010 allowed up to an
  hour) is cut by migration 0012 to end 900 seconds after its claim was first issued (for a 0010
  reissue, the ticket it replaced), never later than it was; one whose cut end has passed is
  expired then, its slot returned to the gap pool and its window lapsed. A cut ticket or window
  records its former end (`legacy_expires_at`); nothing that had already ended changes.
- **Explicit rules (local fixture only).** Rehearsal file version 2 (`rare-city/local-property-
  rehearsal-v2`) may list an NFT as `{ "asset": "<id>", "traits": { "<name>": "<value>" } }` and
  declares `"districtRules": [{ "id", "collection": { "chain", "contract" }, "traits"?, "district" }]`.
  A rule applies to an NFT of its collection with every listed trait, in a city that has its
  district. When the player selects an NFT (`POST …/assignment`) and a rule applies, the server
  releases their unused fallback slot to the gap pool and issues a rule ticket for that NFT and the
  rule's district, before any plot is chosen; the page moves the placement there. A fallback ticket
  cannot place an NFT a rule assigns (`district_rule_applies`); a rule ticket places only its NFT.
  These are TEST DATA standing in for Proofy Core rule results, never reported as verified.
- **Restricted districts (policy D1, locked 2026-10-21).** A district with a Proofy rule is
  RESTRICTED: never in the default rotation. File version 3 (`rare-city/local-property-rehearsal-v3`)
  adds `"ruleResults": [{ "guild"?, "discordUserId", "verificationRuleId", "qualifies": true | false
  | null }]`, the local stand-in for Core's `access/check` (`guild` limits a result to one Discord
  server). A restricted district is reached only by a rule ticket: an explicit rule names it for the
  NFT AND its Proofy rule answers `true` for the session's player in the session's server. `false`
  refuses (`district_rule_unqualified`, 403); no result, `null`, or results that disagree refuse
  (`district_rule_unverified`, 403). The ticket records the district's rule id and that the answer
  was `local-fixture` (the database accepts no other source until a verified Core contract exists);
  the activation asks again under the city lock and refuses if the answer, the rule or the NFT's
  rules changed. A city whose EVERY district is restricted has an empty rotation: entry answers
  `{ "ticket": null, "awaiting": "asset" }` to a player with an NFT such a rule ticket could place
  (nothing is held meanwhile, so nobody waits), and the player's selection
  (`POST …/assignment` with `"ticketId": null`, allowed only where entry can assign nothing) issues
  it. Anyone else is refused at entry, typed, and may still view the city. Where unrestricted
  districts exist, entry still assigns one at once.
- **Conflicting rules (policy D3, locked 2026-10-21).** Rules that apply to one NFT and name
  different districts are REFUSED (`district_rule_ambiguous`) until the administrator fixes them,
  at entry (all-restricted city), at selection and at activation, before any plot is chosen, whatever
  their order, ids or types, and even where the player qualifies for one of them; the page never
  names a district, so no plot choice gets around it. Rules naming the same district agree: their
  ids are recorded sorted and deduplicated (at most 200 characters, `district_rule_ref_too_long`
  beyond, never shortened).
- **Rule changes (policy D4, locked 2026-10-21).** A change of the rotation (the unrestricted
  districts, their order, or the geometry) supersedes EVERY pending ticket in the adoption's own
  transaction (below). A change of rules only (explicit fixture rules, rule results, holdings, or a
  restricted district's Proofy rule in a new configuration version) supersedes EXACTLY the rule
  tickets it affects, recorded as `supersede_cause: "rules"`: a rule ticket stands only while its
  holder still holds its NFT, the NFT's rules name the same district with the same rule ids, the
  district has the same Proofy rule, and that rule still answers `true`. A fallback ticket names no
  NFT and no rule, and an NFT's rules are judged again when it is placed, so a rule-only change never
  touches it. Unaffected tickets keep their id, district, ordinal, generation and end. Affected
  holders keep their claim window and are assigned again only by a new, fully checked request of
  their own. A restricted district's rule change is applied in the adoption's transaction; a fixture
  change by the first ticket transaction in the world after the restart that loads it (until then
  the activation refuses an affected ticket). Committed properties and ticket history never change.
- **Commit.** Only inside the property activation's transaction, under the city lock: the ticket is
  locked after the rotation and must be the activator's live ticket of the rotation's current epoch,
  issued on the geometry that governs now; the plot must be in its district. Geometry check, ticket
  check, freeze (first property), property, event, sequence and the ticket's consumption commit
  together or not at all; a refused or failed activation consumes nothing and freezes nothing; a
  repeat of a completed activation returns the property and consumes nothing more. In a world with a
  rotation the database refuses a property that consumed no ticket.
- **Geometry.** Every ticket records the configuration version, hash, layout geometry and district
  geometry it was issued on, and its rotation epoch. An adoption that changes the default districts
  or their geometry (possible only before the first property, or by a change of which districts carry
  a Proofy rule) begins a new epoch IN THE ADOPTION'S TRANSACTION: every active ticket is superseded,
  every unconsumed slot of the old epoch retired, and each superseded fallback ticket with time left is
  reissued to its holder, in their old order, in their claim window (never longer). A rule ticket is
  superseded and not reissued (the player selects the NFT again). A presentation-only version keeps tickets and
  epoch. The database refuses an adoption that leaves the rotation behind. The stale-map protection
  (`config_superseded`) and Play's active-configuration check for a first property are unchanged.
- **Locks and transactions.** Always city row (FOR SHARE to issue, FOR UPDATE to adopt or activate),
  play session (FOR SHARE), rotation, tickets, slots. Every transaction is short; none is open while a
  player browses or chooses a plot. Nothing provisional advances a sequence or writes an event.
- **Database gates (migration 0012).** Beyond the service's own checks, the database judges, from
  the persisted configuration copies only (the latest adoption, that version's canonical text and
  recorded geometry): a rotation is exactly its governing version's unrestricted districts in
  order; an adoption leaves no live ticket that version does not authorize (a fallback ticket on an
  unrestricted district of the rotation; a rule ticket recording exactly the Proofy rule the version
  names for its district), so a rule-only change must supersede the affected rule tickets in its
  own transaction; and a ticket commits only against the version that governs at that moment, while
  the rotation follows it. This is consistency with stored configuration, never eligibility: NFT
  holdings, traits, roles and rule answers are still the trusted source's (locally the fixture).
- **`city:verify`** checks every rotation, slot and ticket (`server/src/world/verifyTickets.ts`).

**What is still not decided or not available (production).** Policies D1 to D4 above are the
owner's locked rules. Still outside this repository:

- where production rule results come from: Proofy Core's verified NFT, trait, role and rule
  evaluation (no contract yet), never a browser and never Play's configuration (schema v1 has no
  rule field, and none was added). Locally the fixture stands in, marked `local-fixture` in every
  ticket and never shown as verified;
- whether one NFT may qualify for several groupings, and whether explicit-rule claims should
  rebalance the fallback rotation (they do not consume it here);
- multi-NFT claim limits beyond one active ticket per player;
- **OPEN (owner decision, audit L1):** in a city with unrestricted districts, entry is judged by
  NFT alone (an authenticated player with an unplaced NFT of the city), so a player whose EVERY NFT
  an explicit rule sends to a restricted district they do not qualify for still receives a
  provisional fallback ticket at once. It never activates (every selection and activation of such
  an NFT is refused `district_rule_unqualified` / `district_rule_unverified`, and the NFT cannot be
  placed on the fallback district either), but it holds a rotation slot and opens a 900-second
  claim window until it is released or runs out: later entrants are assigned past that slot
  meanwhile (it returns to the gap pool, oldest first, so nobody is skipped for good), and the
  player sees an assigned district they cannot use. Whether entry should first check that at least
  one NFT is placeable is not decided; behavior is unchanged and covered by a regression test
  (`server/tests/districtTicketHardening.db.test.ts`).

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

**Local test construction (P1-C2-E3A, migration 0013): LOCAL ONLY, VALUELESS TEST CREDITS ONLY.**
The first thing a player can build into a property, through the property's own panel (no separate
page), against the real session, world and stores (`server/src/world/construction.ts`):

- **What one action is.** One fixed step of the engine's current recipe, since P1-C2-E3B
  `local-test-tier2-v1` (`src/world/construction.ts`): 50 units an action, Tier 1 at 100 lifetime
  units, Tier 2 at 250, nothing above Tier 2 (`construction_complete`); a step stops at each tier's
  threshold. These are PROVISIONAL LOCAL TUNING, not a price or a tier policy. (E3A's
  `local-test-tier1-v1`, which stopped at Tier 1, is retired: its records keep its meaning.) The
  page sends `POST /v1/play/rehearsal/constructions` with exactly `{ sessionRef, worldId,
  discordUserId, propertyId, role, actionId }`: never an amount, a cost, a tier or a state. The server
  computes the step under the city lock and answers what committed; `GET
  /v1/play/rehearsal/construction?property=<id>` reads a property's construction for the session's
  player (tier, progress, their test credits, investment split, history naming nobody else).
- **One transaction.** The city advances exactly one sequence (state version 3: the building's tier,
  lifetime units and latest construction sequence) with its `world.property.constructed` event, a new
  control era if one began, the construction record and the debit (with any file grants not recorded
  yet), or nothing. Property id, NFT, district, plot, original activator and the activation event
  never change.
- **Test credits.** Rehearsal file version 4 (`rare-city/local-property-rehearsal-v4`) adds
  `"testCredits": [{ "id", "guild", "discordUserId", "units" }]` (1 to 1000 units, at most 20 per
  player and server). A grant is recorded once, by its id, inside the first construction of that
  player in that server's city; nothing else grants credits, and no route does. One append-only
  running balance per player and world (`world_test_credit_entries`), never below zero; an action
  costs exactly its units. Not RF, Proofy Points or any currency.
- **Who builds as owner.** Founding a property does NOT make anyone its owner here. File version 4
  also adds `"controllers": [{ "guild", "asset", "discordUserId" }]`: who controls an NFT NOW in one
  Discord server's city, as TEST DATA (one per NFT and server; never shown as verified ownership).
  `role: "owner"` needs exactly that player (`not_current_controller`, or `control_unverified` when
  nobody is named); anyone else builds as `patron` (the controller cannot: `controller_builds_as_owner`).
  A construction is open only in a server the file names in either list (`construction_not_open`
  elsewhere, read and write: those cities look exactly as before).
- **Eras and attribution.** The first action to see a controller records the property's next control
  era (`world_property_control_eras`). Investment is split into the current owner's (owner units of
  the latest era, while the file still names its controller), previous owners' (every other owner
  unit) and patrons' (every patron unit); a player's own builder progression counts only their owner
  units. Changing a controller in the file and restarting simulates a transfer; no transfer mechanism
  exists.
- **Idempotency and concurrency.** `actionId` is a fresh UUID per press, unique per world. The same
  press again (a retry after a lost answer) answers the construction it made, `fresh: false`, and
  costs nothing; any other use of the id is refused (`action_conflict`). Every construction of a world
  queues on its city row, so concurrent actions never overspend.
- **An answer that does not say what happened (independent audit M1).** A construction that committed
  is answered as built even when the property cannot be read again just after (`view: null`; the page
  reads it itself). Any other failure nobody refused is `503 construction_unconfirmed`: it may or may
  not have been written. The page keeps a press (its world, player, property, role and id, in this
  browser's storage) until the server answers it with a construction or a refusal decided after no
  construction was found under the id; until then it says it could not confirm the build (never that
  nothing was built), its one action asks again with that same press, after a reload or relaunch too,
  and no other property of that player in that city gets a new press.
- **No civic award (independent audit M2).** Local test construction is drawn at its tier, but the
  Crown, the Capital and monuments are not computed from it: in a persistent city they stay vacant,
  and the city note says so. Whether real construction will ever count toward them is not decided.
- **Database defense.** Migration 0013 refuses every construction, era and ledger entry outside a
  local database, any change or removal of one, a step that is not the recipe's, a contributor who is
  not the acting session's player, an owner outside the current era, an unpaid or mis-paid
  construction, a balance that is not its running sum or goes below zero, and a city advanced by a
  construction event with no construction behind it. `city:verify` replays activations and
  constructions together and checks eras and ledgers.

**Tier 2 and Architect activity (P1-C2-E3B, migration 0014): LOCAL ONLY, VALUELESS TEST CREDITS ONLY.**

- **Versioned recipes.** Every construction record and event names the recipe that computed it. The
  current recipe `local-test-tier2-v1` extends `local-test-tier1-v1` (the same step and Tier 1), so a
  Tier 1 property built under E3A simply continues: three more steps reach Tier 2. Migration 0014
  adds the new recipe to the database's two recipe functions (their tier1-v1 answers unchanged) and
  refuses any new construction by another recipe; the server never accepts a tier, recipe, goal or
  amount from the browser. A repeated press answers its own stored record, whatever recipe is current.
  `city:verify` also refuses a construction by an older recipe after a newer one on the same property.
- **Tier 2 in the city.** The stored tier is drawn by the standard renderer's own Tier 2 (taller), and
  progress inside Tier 1 rises with each step. Tier 2 from local test construction earns no Crown,
  Capital or monument, as Tier 1 did not.
- **The card.** It shows the next provisional goal (the tier, the lifetime units that reach it and the
  steps left by anyone), how many players built as owners and as patrons (nobody named), and marks a
  history entry an earlier recipe built. A pending press also keeps the recipe and tier the page showed
  when it was made (`intent`): display only, never sent.
- **Architect activity.** `GET /v1/play/rehearsal/architect` (read only, the cookie's session's
  player only, nothing the request names) and its panel, opened from MY PROPERTIES and from the
  construction card: the player's owner units (built while the local file named them the NFT's
  controller), split into control eras they still hold and earlier ones; their patron units (which
  never count as their own progression); tier changes their steps completed; and every property of
  this city they founded, are named controller of now, or built on, with its tier, progress and the
  next step they could take. Descriptive only: no rank, level, XP, badge or reward. A new controller
  starts from none of a previous owner's units; earlier owners keep theirs.
- **Browser tests.** `tier2.spec.ts` (and the E3A tests in `construction.spec.ts`, whose Tier 1 is no
  longer the top).

Not decided, on purpose: any real currency or price, tiers above 2 and final tier balancing, any
other recipe, verified NFT control (Proofy Core), real transfers, patron rewards and recognition,
Architect ranks, levels or rewards, official civic awards for construction, and whether or how
construction opens outside the local rehearsal.

**Architect design (P1-C2-E4A, P1-C2-E4B, P1-C2-E4C, migrations 0015, 0016, 0017): LOCAL ONLY, LOCAL TEST CONTROL ONLY, FREE.**

- **What can be chosen.** From the current versioned catalog (`architect-design-v3`,
  `src/world/design.ts`): a facade (slate, limestone, brick, copper, jade), a roof (flat, terrace,
  dome, spire), windows (grid, arched, ribbon, lattice: the renderer's own window patterns),
  exterior lighting (standard: the usual warm glow, no floodlights; warm and cool: static floodlights
  washing the facade above the podium and lighting the top cornice, with a matching window glow), an
  entrance (standard: the usual lit door; canopy, arched: the renderer's awning and arch; portico: its
  columned portico, closed up to fit the podium face) and landscaping (standard: bare paving; garden,
  courtyard: fixed arrangements of the renderer's landscape pieces, `GROUNDS` in
  `src/ui/city/buildingGeometry.ts`). Each is an identifier the standard renderer already draws; no
  color, markup, URL, position, upload or text is ever sent, stored or drawn as sent. A property never
  designed is drawn with slate, flat, grid, standard, standard and standard, as every new building is.
  A Tier 0 foundation draws its facade at once and its roof, windows, lighting, entrance and grounds
  from Tier 1; the design then grows with every tier. Far from the camera the floodlights keep only
  their lit cornice and the landscape pieces are not drawn. Tier, height, plot, district color and the
  NFT's label are never the design's.
- **Landscaping stays on the property.** Every piece stands inside the property's own paved lot (its
  road-safe envelope), clear of the podium and of the other pieces; only low pieces stand before the
  entrance face, so none hides the entrance, a window face or the label; pieces are never pointer
  targets, so the building's hit area is unchanged. A lot too tight for a piece loses the piece rather
  than spilling it (no lot of the sample cities' first five wards is that tight). `src/ui/city/grounds.test.ts` checks this for every
  plot of the sample cities' first five wards, at Tier 1 and 2 and all 24 rotations, against roads,
  neighbouring lots, district gates and the civic centre.
- **Catalogs v1 and v2.** Designs saved before E4B (`architect-design-v1`: a facade and a roof) and
  before E4C (`architect-design-v2`: and windows and lighting) keep that catalog and meaning; they name
  no treatment their catalog did not have and are drawn with the standard ones, exactly as before.
  Neither takes a new save (the database refuses one): a v1 or v2 save a page kept is checked exactly
  as kept, answered with its receipt if it was recorded and refused (`design_retired`, nothing saved)
  if not.
- **Who may change it.** Only the player the local file's `controllers` name as the NFT's current
  controller in this city (TEST DATA, never verified ownership), asked again for every save under the
  city lock. Founding the property, building on it as a patron or having controlled it before allow
  nothing; everyone sees the saved design and its card. A city the file names no test data for saves
  none (`design_not_open`).
- **Routes.** `GET /v1/play/rehearsal/appearance` (every saved design of the session's city, read
  with the rehearsal data on load), `GET …/design?property=` (one property's design, its history with
  nobody named, and whom the file names its controller) and `POST …/designs` (`{ sessionRef, worldId,
  discordUserId, propertyId, actionId, baseRevision, catalog, facade, roof, windows, lighting,
  entrance, landscaping }`, exactly these keys; without `entrance` and `landscaping` only as an
  earlier page's v2 save, and without `windows` and `lighting` too only as a v1 save).
- **The player's view.** The property panel's ARCHITECT DESIGN card; for the named controller, Open
  Architect design (also DESIGN in the Architect activity). Each choice is previewed on the city's own
  building at once and beside the saved version (both drawn by the city's building sprite), with a line
  naming every category the preview changes. The six categories are grouped in three tabs (Building,
  Details, Street level; ARIA tabs, arrow keys move between them), each saying how many of its
  categories the preview changes; all six are saved together as one revision; nothing is
  sent until Save, and Cancel, Back, Close or another building drop the preview. No polling: the
  page reads designs on load, after a placement and after a save.
- **Persistence and safety.** Each save is the property's next revision (append-only; any earlier
  design can be restored by a later save); a save made on an older revision is refused
  (`design_stale`), one equal to the current design too (`design_unchanged`). A press id names one
  save: a repeat returns it (`fresh: false`), the id with anything else is `action_conflict`, and a
  save whose answer is unknown (`design_unconfirmed`, a lost answer) is kept in the browser
  (`rare-city-design-saves`, apart from construction's presses) and checked again exactly as first sent
  before anything else is saved. A design spends no test credit, adds no construction unit, never
  moves a tier, a founder or a city sequence, and earns no Crown, Capital or monument.
- **Transfer.** A design belongs to the property: when the file names another controller, the saved
  design stays drawn, the former controller can no longer change it and the new one can. Public owner
  media (billboards) is not a design and has no route here.
- **`city:verify`** checks every design: a property of its world, revisions 1, 2, 3 ..., a catalog
  choice this build has, the local fixture authority, a city sequence within the property's life.
- **Browser tests.** `design.spec.ts`, `design-details.spec.ts`, `design-street.spec.ts` (construction Discord servers per run: 200).

Not decided, on purpose: more catalogs or slots, freeform or per-piece landscaping, paid, earned or unlockable designs, a design
marketplace, uploads or custom media, billboards and public owner media's transfer rules, verified NFT
control, and whether or how design opens outside the local rehearsal.

Needs a verified Proofy Core / Play contract:

- **F3. Game status.** Play's installation answer does not include the game's status. While
  Play refuses launches for an inactive (`draft`) game, existing sessions still read the
  installation as active. (A retired game is caught: Play refuses Rare City's credential, F1.)
- **F7. Mid-session membership and entitlement.** Core checks Discord membership and the
  server's Play entitlement only when it signs the launch context. No Core or Play contract lets
  Rare City re-check either during a session, which is why the viewer reports both as verified
  at launch, never now.
