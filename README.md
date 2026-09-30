# Generations City

**Build your Friend. Build your district. Build the city.**

Generations City is a shared social strategy city for Rare Friends. Players own buildings inside nine family districts around a central Capital Plaza. Every RF spent on a property physically develops that building, so spending RF is how the city gets built.

> **Everything in this build is simulated.** All RF shown is **SIMULATED RF**. No real tokens move, no wallet is connected, nothing is written to a chain, and every Friend ID is a clearly labelled **Demo Friend**.

---

## The idea in one loop

1. Open the **Build Board**. It lists strategic opportunities ranked by impact.
2. The top card reads *"Demo Friend #812 · 38 RF until Tier 4 · Captures The Grand Fountain from Sparkling."*
3. Press **WARP**. The camera flies across the city to that tower and selects it.
4. Contribute 38 **SIMULATED RF**. The tower grows, crosses into Tier 4, and a burst of construction effects plays.
5. The **Family District** now has more Tier 4+ buildings than the **Sparkling District**. **The Grand Fountain** crumbles out of Sparkling's civic square and rises in Family's, with a shockwave, a light column and a transfer arc (*"The Grand Fountain: Sparkling → Family"*). The City Hall registry pylon changes colour.
6. You earn the **Closer** and **Kingmaker** badges, and **District Radio** broadcasts *"The Grand Fountain STOLEN"*.
7. The Build Board now shows the next move. Demo Friend #288 is **63 RF** from Tier 3, and that tier-up makes the Family District **the Capital**. Family gains gold edging, Capital flags bearing its family art, a gold causeway to City Hall and a floating *FAMILY DISTRICT · HOLDS THE CAPITAL* crest, and City Hall's flag, facade banners and sign switch to the Family crest and name.

The judge-facing path takes about 30 seconds. The **Demo Guide** card walks through it and ticks off each step from real game state. You can hide it, reopen it any time with the **?** button in the HUD, and a small reminder pill stays visible until the core loop is done. **Reset Demo** restores it.

## Four motivations

| Motivation | In the game |
| --- | --- |
| **My Building** | Owner direct-build, the **Architect Mode** design system, fixtures, landscaping and a billboard. Height tracks RF, so your tower visibly rises. |
| **My Legacy** | Permanent badges (Groundbreaker → Master Architect, Self Made, High-Rise, Skyline Legend, People's Tower, Closer, Kingmaker, Capital Maker, Crowned…) with Bronze/Silver/Gold/Diamond levels. |
| **My Presence** | Patron recognition grows with how much you give one building: supporter list → entrance plaque → Friend marker → facade banner → illuminated crest → grand patron. At most three patrons are shown on each exterior, and the rest appear in *View Patrons*. |
| **My District** | Civic-landmark monuments (T2 Founders' Arch, T3 Builders' Obelisk, T4 Grand Fountain, T5 Friend Statue, T6 Beacon Tower), the **Capital** race and the individual **City Crown** for the tallest building. |

## Rare Friends / RF connection

Vibeathon category: **Token Activity** (primary), **Economy Potential** (secondary).

- RF spending is not a tax or fee bolted onto the game. It *is* the game action, and it physically builds the world.
- Players keep choosing where their RF matters most: their own tower, their own architecture, a rival's near-tier building, a monument capture, Capital offense or defense, their personal badges, or the tallest-building race.
- **Customization is construction.** Fixture and landscaping purchases count toward both Owner Build and Total Build, so buying something beautiful never costs you progression.
- Owner Build is its own progression track. Only personal owner spending raises your **Architect Level**, which unlocks facades, roofs, windows, lighting and landscaping slots. Other players can help your building tier up, but they can't earn your Architect progress for you. This keeps "only snipe near-tier buildings" from being the optimal strategy.
- The Capital is **prestige only**. It gets no score multiplier and no snowball advantage.

### Why this MVP does not use FriendSDK

Generations City needs a persistent shared-world data model (buildings, patrons, monument and Capital history), rich property customization, user-uploaded billboard media, and a full-viewport game UI. None of these fit the current FriendSDK sandbox model. For the hackathon, the game runs on deterministic local state behind small adapter boundaries:

- `src/config/identity.ts` is the **identity adapter**. It holds demo users, demo Friend labels and a `DEMO_PLAYER_ID`. A real integration would replace this data source with wallet connection and Rare Friend ownership lookup.
- `src/config/districts.ts` defines the **district config** (stable internal ids `d1`…`d9`, geometry colours), and `src/config/districtIdentity.ts` is the **official family identity boundary**: the district → family mapping, official names, art paths, accent colours, credits and supply metadata. See [Rare Friends families](#rare-friends-families-and-district-identity).
- The economy (`src/game/*`) is pure TypeScript that takes and returns plain state. A backend or chain indexer could run the same functions server-side.

## Rare Friends families and district identity

The nine districts are the nine official Rare Friends family/type identities, supplied by the product owner for this build:

| Internal id | Family | Supply class (approx.) |
| --- | --- | --- |
| `d1` | **Hollow** | rarer |
| `d2` | **Sparkling** | rarer |
| `d3` | **Colossus** | rarer |
| `d4` | **Family** | higher supply |
| `d5` | **Cellular** | higher supply |
| `d6` | **Mask** | higher supply |
| `d7` | **Asymmetry** | higher supply |
| `d8` | **Skeleton** | higher supply |
| `d9` | **Hoverer** | rarer |

- **The district-number mapping is a product configuration choice** for this build. It is not a claim that Rare Friends assigns these families to numbered districts. It lives in one place, `DISTRICT_FAMILY` in `src/config/districtIdentity.ts`, and every label, crest, banner, message and statue follows it. Internal ids (`d1`…`d9`) are unchanged, so state, tests and save data stay compatible.
- **Naming system.** Running text uses the family name (*"The Grand Fountain: Sparkling → Family"*); headings and signage use *"Family District"* / *FAMILY DISTRICT*. A subtle roman numeral (*DISTRICT · IV*) remains as a secondary reference.
- **Family art.** Two official silhouettes per family (`public/assets/families/<family>-1.svg` and `-2.svg`) were **supplied for the hackathon build**. They are kept unchanged as canonical sources. `npm run families:derive` (`scripts/derive-transparent-families.mjs`) writes transparent copies to `public/assets/families/transparent/` by removing only the explicit full-canvas black `<rect>`. The Friend `<path>` is copied byte-for-byte and nothing is rasterised. The script also generates the silhouette bounds in `src/config/familyArtMetrics.ts`. Unit tests check that each derivative equals its source minus that single rect, and an E2E test checks in the browser that derivatives have transparent pixels where the sources are opaque black.
- **Art is civic identity, not wallpaper.** Buildings are not decorated with Friends. The **primary** silhouette is the district crest: map district labels, district gateways (mid/near zoom), HUD, Build Board tabs and district header, Standings, district chips, the allegiance card, City Hall's flag, the Capital sign and crest, and the T5 statue. The **secondary** silhouette is kept for banners: Capital flags, City Hall facade banners and the faint banner behind the allegiance card. Overview zoom shows only the label crests; gateways and flag art appear as you zoom in.
- **Capital vs T5 statue.** These are separate competitive systems. City Hall, the Capital sign, crest and flags show the family that holds the **Capital**. The T5 Friend Statue shows the family that holds the **T5 monument**. They can be different families and are drawn independently.
- **Accessibility and performance.** Family art is referenced by URL (`<img>` / SVG `<image>`), never inlined. Each file is under 1 KB. Crests are decorative (`alt=""`, `aria-hidden`) because the family name is always next to them. Map objects carry `data-family` for stable test selectors.

### Family population and fairness

Current family populations are very uneven. These are **approximate product-planning inputs, not live or authoritative on-chain counts**:

- **Rarer families:** Hollow, Sparkling, Colossus and Hoverer, each roughly 3,200–3,350
- **Higher-supply families:** Skeleton, Asymmetry, Mask, Cellular and Family, each roughly 23,500

These values are stored as informational metadata only (`FAMILIES[…].supplyClass` / `approxPopulation`). A unit test checks that no game or scoring code reads them. Standings marks rarer families with a small *RARER* tag in the seasonal-signals preview.

**Production fairness principle:** *"District success measures how effectively a seasonal community participates relative to its active representative population, rather than simply rewarding the family with the largest total supply."*

- Production seasonal competition should normalise against **declared / active seasonal participation** (Representative Friends), not raw NFT supply or raw permanent building count.
- A naive supply multiplier (for example 7× for rarer families) is explicitly **not** the intended approach.
- Candidate signals: share of seasonal representatives active, construction per active representative with diminishing returns, tier-ups per representative, unique active builders, patron activity, monument control and other normalised seasonal signals. No final formula is chosen.
- **The current hackathon scoring is unchanged and simplified.** Monuments and the Capital still use all-time cumulative tier counts, which favour higher-supply families at scale. This is a known limitation of the demo.

## City scale: a dense city that grows with its community

Rare Friends has roughly 330,000 Friends and more than 273,000 holders. Generations City is designed so that **the physical size of the city reflects the growth of its community**.

- **A Friend only gets a property once it becomes active in the city.** An NFT existing does not create a building, and nothing is pre-rendered for inactive Friends.
- The **nine districts** are permanent, family-level geography: nine 40° wedges around City Hall. A Friend's building always stays in its family district.
- **Dense, small-footprint city.** Building footprints are narrow: about 55% less width and depth than the first pass (half-size 0.7 world units at Tier 0 up to 1.12 at Tier 6). Heights are unchanged, so T5 and T6 towers dominate the skyline and monuments read as genuinely large. Lots sit about 5.2 units apart in back-to-back rows separated by streets.
- **Procedural, effectively unbounded wards.** Each district grows outward in wards (neighbourhoods). Ward N's geometry (band radius, four plot rows, a mid-ward street, and plot positions) is derived from its index on demand, with no pre-generated list and no ward limit. Because outer arcs are longer, capacity grows outward: **Ward I: 21, Ward II: 33, Ward III: 44, Ward IV: 55, Ward V: 65 … Ward XX: 229 plots** per district. The civic square (monument park) is protected from plot placement.
- **Deterministic allocation and ids.** A new Friend takes the first free plot in the lowest open ward of its district (plot id `d4-w0-p6`). When every open plot is taken, the next ward opens automatically, its ground, streets and trees appear, and District Radio announces *"FAMILY DISTRICT OPENS WARD II"*.
- **Founding Ward prestige only.** Ward I is labelled the *Founding Ward*: addresses show it and owners get a *Founding Resident* badge. It gives no scoring multiplier, cheaper building, better rewards or permanent competitive bonus. Later wards are not weaker, and may later get their own visual character, parks and landmarks.

```
City
 └─ District (9, permanent family geography)
     └─ Ward I (Founding Ward: civic square + 21 plots) → Ward II (33) → … → Ward N (procedural)
         └─ Plot (deterministic id + position)
             └─ Building (created when a Friend becomes active)
```

**What exists now**
- `src/config/world.ts` defines the world layout in renderer-independent world units: plaza, ring road, civic square, ward depth, row offsets and plot spacing.
- `src/game/world.ts` holds the pure geometry: `wardBand(n)`, `wardRows(n)`, `wardCapacity(n)`, `plotWorld()`, `plotId()` and the civic-square monument slots.
- `src/game/allocation.ts` holds `findAvailablePlot`, `allocatePlot` (opens the next ward at capacity, with an optional caller cap but none by default), `districtGrowth`, `wardName` (roman numerals for any ward) and `isFoundingWard`.
- **Tests** cover Ward V and Ward XX geometry (inside their bands, no overlaps, correct capacity, invalid plots rejected), deterministic ids and positions, and filling 19 wards so allocation automatically opens Ward XX.
- The seed has **180 buildings**: 54 hand-tuned founders plus 126 residents, 14 per district with an **identical tier mix in every district**. Density adds the same constant to every district's scores, so every seeded scenario keeps its exact gaps.
- **Districts → City Growth → "+ Friend joins"** simulates a new Friend. Sparkling and Family are full (21/21) at seed, so a join there opens Ward II immediately.
- Unclaimed **open plots** are outlined, and a dashed **ghost ward** beyond each district shows where the city expands next.

**What the demo does not do:** simulate or render hundreds of thousands of buildings. Only the wards that exist are instantiated.

### Rendering at scale: level of detail and labels

Drawing every property as SVG nodes would not scale. The renderer asks a level-of-detail plan what to draw:

| Zoom | Production intent | Current demo |
| --- | --- | --- |
| **Far** | District geometry, ward massing (aggregate skylines), monuments, Capital, Crown, landmarks | **Active.** Wards with more than 12 buildings render each ward's 8 tallest towers in full; other buildings become lightweight massing blocks with lit windows. The player's buildings, the selected building, the Crown holder and the current objective always render in full. |
| **Mid** | Wards and blocks with representative buildings, roads and landmarks | Wards above 60 buildings use representatives. Demo wards render individually. |
| **Near** | Real nearby buildings with architecture, billboards, landscaping and patron marks | Full detail |
| **Ground (future 3D Explore)** | Only geometry around the player's Friend | Not implemented |

- **Label discipline:** at overview and mid zoom, only the selected building, your buildings (**YOU**), the Crown holder, the current guided objective (**★ #812**) and monuments are labelled. Up close, Tier 3+ buildings get labels, and smaller buildings reveal theirs on hover or focus.
- `src/game/lod.ts` contains the renderer-independent LOD logic (`wardRenderMode`, `representativeBuildings`, `intersects`). It is unit-tested.
- **Viewport culling is live.** Only objects whose bounds intersect the camera view are mounted (see `data-rendered` on the map element).
- The static ground renders in its own SVG layer, separate from the animated objects layer.
- In production, the server or indexer would also stream only nearby wards or tiles to the client. The client should never hold every property.

## Seasons: Representative Friend and Home District

**Permanent world state persists forever**: buildings, tiers, RF built, patrons, badges and monument, Capital and Crown history. **Seasonal competition is a separate layer that resets.** The current hackathon scoring (monuments plus Capital) stays deliberately simplified for the demo and is not replaced.

**Implemented (prototype):**
- `src/config/season.ts` defines the season rules and the undated **Demo Season 1**. No fake calendar dates are used.
- `src/game/season.ts` is pure logic: `chooseRepresentative`, `homeDistrict`, `contributionAllegiance`, `recordSeasonActivity`, `seasonSignals` and `startNextSeason`. It is unit-tested.
- **Representative Friend:** each season a player picks one Friend they own, and that Friend sets their **Home District**. The choice is **locked for the season**, so a player cannot hop to whichever district is winning. The seeded demo player already represents with Demo Friend #4471 (internal `d4`), so their Home District is **Family**. The HUD shows *Demo Season 1 · Home District [crest] Family 🔒*, and Profile shows the allegiance card (*HOME DISTRICT: FAMILY* with the Family crest) and a disabled "Change Representative · next season" control.
- **Multiple owned Friends:** the demo player also owns Demo Friend #3710 in the Asymmetry District. You can build and customise every Friend you own. Building outside your Home District strengthens that district.
- **Cross-district construction is allowed but flagged.** Contributing to a rival district's building, or to your own Friend in another district, shows *"This construction strengthens another district."* in the confirmation.
- **Late joiners** may join mid-season. Their join time is recorded for future residency rules (`minResidencyForChampionship` is a documented placeholder and is not enforced).
- **Seasonal activity** (RF this season, tier-ups this season, unique builders) is recorded per building, separate from permanent progress. `startNextSeason` resets allegiance and activity while leaving every building, tier and monument untouched.

**Product direction (not implemented):** production district competition should be **normalised against declared / active seasonal participation**, so that the largest family cannot win on raw supply or raw building count alone (see [Family population and fairness](#family-population-and-fairness)). Candidate signals: share of buildings active this season, RF construction this season, tier crossings this season, unique active builders, patron activity, monument control and strategic completion events. Districts → *Seasonal signals (preview)* shows a live table of these, clearly marked as **not used by current scoring**. There is no reward distribution.

## Property media and advertising

Taller buildings are more valuable visual real estate. This is a deliberate feature, and the owner always controls their own building's media: one image, owner-only edits, uploaded through the framing editor.

| Tier | Media | Implemented |
| --- | --- | --- |
| **T4** | Facade billboard mounted on the tower | Yes |
| **T5** | Skyline rooftop billboard: larger and seen across the district | Yes (rendered on the roof) |
| **T6** | Landmark crown screen: gold-framed rooftop screen visible city-wide | Yes (rendered on the roof) |

- `src/config/media.ts` defines the ladder. Architect Mode → Billboard shows the ladder with your current tier highlighted, and building panels show *"Property media: … · Tier N unlocks …"*.
- There is no ad marketplace, rentals, payments or backend. Production user-generated media would need server storage plus moderation, reporting and content controls.

### Search and WARP

However large the city gets, a player reaches any specific Friend through **search → WARP**. The **Find a Friend** box in the HUD resolves a Friend ID via `findBuildingByFriend()` and flies the camera there. The Build Board, Radio and Profile WARP buttons use the same path. In production this lookup becomes an index query (Friend ID → district / ward / plot), so it works without loading the whole city.

## Architecture: one city state, multiple renderers

```
Shared city / game state (src/game, src/config: pure TypeScript, no DOM)
   ├─ Strategic Map renderer (today): isometric SVG in src/ui/city
   └─ 3D Explore renderer (future): WebGL / Three.js-style, same state
```

- Economy, competition, allocation, LOD planning and world layout contain no SVG or React code.
- World positions come from `game/world.ts` in world units (x, y on the ground plane), and building height comes from `floorsFor()` / `heightMeters()` in `game/economy.ts`. The SVG renderer only projects these isometrically, so a 3D renderer can place the same buildings, wards and monuments directly.
- **Future 3D Explore Mode (not implemented)** would let a player control their Rare Friend with a third-person camera: WASD/touch movement, mouse look, zoom toward first person, walking streets at ground level, and seeing skyscrapers, monuments, billboards and patron markers up close. It should consume the same state rather than being retrofitted into the SVG map.

## What's in the MVP

**P0: core loop**
- Large, dense pseudo-isometric SVG city: 9 districts with park-like civic squares, streets, street trees, open plots and ghost expansion wards; 180 seeded buildings with narrow footprints and a strong skyline; a central Capital Plaza with City Hall and the monument registry
- Camera pan (drag), zoom (wheel, buttons, pinch) and animated **WARP**
- Selectable buildings with owner/other distinction. The player's tower carries a high-contrast **YOU · #4471 · T4** marker, and labels stay a constant size on screen at any zoom.
- Tiers 1–6 at 100 / 500 / 2,500 / 10,000 / 50,000 / 250,000 RF, each with **10 intermediate construction stages** (floors, trim bands, corner lighting, scaffolding and a crane in late stages, uplights, setbacks and roof elements), plus a bigger transformation at each tier
- Height strictly increasing in Total RF, with a readable metre value for the Crown race
- Cumulative district tier counts: a Tier 5 building counts toward Tiers 1–5
- Five moveable **civic landmarks**, each on its own plaza pad in the holder's civic square and tinted in the holder's colours:
  - **Founders' Arch** (T2): a triumphal arch with a central archway and frieze
  - **Builders' Obelisk** (T3): a stepped base, a tapered shaft and a gilded pyramidion
  - **Grand Fountain** (T4): a three-tier fountain with jets and water curtains
  - **Friend Statue** (T5): a monumental bronze cast of the **holding family's** official Friend silhouette on a pale-stone plinth with a gilded family inscription and uplighting. When the T5 monument changes hands, the old family's statue collapses and the new family's form rises.
  - **Beacon Tower** (T6 wonder): a striped lighthouse with sweeping beams
  - Capture plays a demolition and dust cloud where the monument stood, then a shockwave, light column and rise at the new site, plus a transfer arc, a headline announcement, radio and history.
- Capital scoring with weights T1×1, T2×3, T3×8, T4×20, T5×45, T6×100; ties keep the incumbent. The Capital district gets temporary, prestige-only identity: gold edge lights, Capital flags with the family's secondary silhouette, a gold causeway to City Hall, a floating family crest, a ★ CAPITAL label, and City Hall's flag, banners and sign in that family's name and art.
- **City Crown** spire on the tallest building, with transfer and history
- Build Board: City Hotlist, Highest Impact, Closest to Next Tier, Monument Opportunities, Capital Offense/Defense, all with WARP
- Deterministic seed and **Reset Demo**

**P1**
- Owner-only **Architect Mode**: facade, roof, windows, entrance, crest, rooftop fixture and lighting, gated by tier, Architect Level and fixtures
- Fixture catalog (Tree, Shrub Set, Planter, Bench, Lamp Posts, Entrance Upgrade, Rare Friend Crest, Rooftop Sign, Premium Facade, Premium Roof, Billboard)
- Landscaping in 8 bounded lot slots (unlocked by Architect Level) with place, swap and remove
- Permanent badges with levels; profile with stats, live (temporary) titles and permanent history
- Patron zone on each building, capped at three external identities, with more detail at close zoom
- **District Radio**: game-generated broadcasts, critical-threshold alerts and **Rally pings**. There is no free-text chat.
- `localStorage` persistence under a versioned key, with a structural validity check and fallback to the seed

**P2**
- **Billboard** fixture (Tier 4+) for JPEG/PNG/WebP up to 5 MB. **Upload** or **Replace** opens an edit mode with the billboard's exact 2:1 crop frame. You drag to reposition and zoom (slider, ± buttons or keys) to crop, and a live low-res preview appears on your tower. **Save** bakes a 480×240 JPEG into local demo state, **Cancel** restores the previous billboard, and there are also **Adjust framing** and **Remove** options. The image is always clipped into the building's fixed billboard surface.
- Construction FX, tier-up bursts, monument transfer animations, and announcement and badge toasts
- Deterministic **rival move** simulator: a non-player district funds its most impactful near-tier building through the same economy code
- Build Board, radio, standings and profile history views

### Demo scenarios (seeded)

| Scenario | Seed state |
| --- | --- |
| **Kingmaker** | Demo Friend #812 (Family) is at 9,962 RF, **38 RF** from Tier 4. Family has 2 T4+ buildings and Sparkling holds the Grand Fountain with 2, so the tier-up makes it 3 vs 2. |
| **Capital** | Colossus is Capital at 131 points, with Sparkling on 130, Asymmetry on 127 and Family on 111. After the Fountain capture, Family ties at 131 (the incumbent keeps it). Demo Friend #288 is **63 RF** from Tier 3 (+8 points), which takes the Capital. |
| **Crown** | Demo Friend #120 (Asymmetry) holds the Crown at 182,400 RF. Demo Friend #505 (Colossus) is 2,500 RF behind. |
| **Your tower** | Demo Friend #4471 is Tier 4 (billboard-eligible) at 72% owner-funded. Buying the Premium Roof and Crest pushes it past 75% and earns **Self Made**. |
| **Rival response** | Demo Friend #266 (Sparkling) is 130 RF from Tier 4. |
| **T5 statue** | Colossus holds the T5 Friend Statue (tie with Asymmetry, first in district order), so the statue is cast in the Colossus form. Colossus also holds the Capital at seed; after the Capital flips to Family, the statue stays Colossus: the two systems are independent. |
| **City growth** | Sparkling and Family have full Founding Wards (21/21), so a new Friend joining opens Ward II. Hollow still has one open plot. |
| **Allegiance** | The demo player represents Family (Demo Friend #4471, internal `d4`, locked for Demo Season 1) and also owns Demo Friend #3710 in Asymmetry, so building it shows the cross-district warning. |

## Run locally

```bash
npm install
npm run dev
# open http://localhost:5173
```

## Tests

```bash
npm run lint       # ESLint (TypeScript + React hooks rules)
npm run test       # Vitest: deterministic game/economy logic
npm run test:e2e   # Playwright against a production build (vite preview) + screenshots
npm run build      # Type-check + production build
```

The first E2E run needs a browser: `npx playwright install chromium`.

Playwright writes screenshots to `test-artifacts/screenshots/` (git-ignored):
`01-city-overview.png`, `02-close-building.png`, `03-monument-capture.png`, `04-architect-mode.png`, `05-billboard.png`, and for family identity `06-family-overview.png`, `07-capital-family.png`, `08-season-allegiance.png`, `09-t5-family-statue.png`, `10-district-family-closeup.png`.

## Project layout

```
src/
  config/        # all tunable data: economy thresholds, districts, district identity
                 # (official family names/art/mapping), world layout, monuments, fixtures,
                 # architecture options, badges, identity adapter
  game/          # pure deterministic logic (no React)
    economy.ts       tier / stage / height / split / patron / architect levels
    competition.ts   cumulative tier counts, monuments, Capital, Crown
    actions.ts       applyBuildRF (the one RF path), fixtures, architecture,
                     landscaping, billboard, rally, rival turn
    projection.ts    what-if impact of a spend (Build Board, previews, alerts)
    buildBoard.ts    strategic opportunities per district + city hotlist
    badges.ts        metrics + permanent badge evaluation
    narration.ts     District Radio text
    world.ts         renderer-independent world geometry (procedural wards, plots, civic squares)
    allocation.ts    plot allocation + unbounded ward expansion
    season.ts        seasonal Representative / Home District / seasonal activity (prototype)
    lod.ts           level-of-detail planning + culling helpers
    demo.ts          guided-demo progress derived from state
    seed.ts          deterministic demo city
    persistence.ts   versioned localStorage load/save
  ui/            # React presentation
    city/            SVG strategic map: projection, ground layer, buildings,
                     monuments, plaza, camera, culling
    panels/          Build Board, building, Architect, standings, profile, radio
e2e/             # Playwright specs
```

## Known limitations

- **All economy activity is simulated and local.** Each browser has its own city, and "multiplayer" rivals are seeded NPCs plus a deterministic rival-move button.
- **Billboard images are browser-local.** They're stored as compressed data URLs in this browser's `localStorage` only. A production version would need server-side storage, moderation, user reporting, and content and abuse controls before any user-generated media is shown to other players.
- Identities are demo-only. Nothing implies that a Demo Friend ID is a real NFT.
- Ambient animation (window flicker, beacons, fountain ripples) uses stepped CSS animation on a separate objects layer. It is light on GPU-accelerated browsers but still noticeable on software-rendered or low-power devices. `prefers-reduced-motion` turns it off.
- LOD aggregation runs at overview zoom in the demo. Hundreds of thousands of properties would also need server-side tiling and streaming, which is not built.
- **Seasonal scoring is simplified.** Seasons record allegiance and activity, but district competition still uses the all-time monument and Capital model. Normalised seasonal scoring, championship residency and rewards are direction only.
- The monuments are original art. Official Rare Friends family silhouettes (supplied for this build) appear only as civic identity and as the T5 statue's form; see `districtIdentity.ts`.
- **Family supply is uneven and current scoring does not normalise for it.** The approximate family populations are planning inputs only; see [Family population and fairness](#family-population-and-fairness).
- There is no 3D Explore mode yet. See the architecture section.
- Mobile and touch work (pinch, drag, bottom-sheet panels), but the experience is designed desktop-first.
- Depth sorting is per object, so very tall towers can overlap neighbours' labels at some angles.
- No audio.

## Production integration needs

- Wallet connection and verified Rare Friend ownership behind `identity.ts`
- A shared authoritative backend or indexer running the same `src/game` functions, with real-time fan-out of radio events
- Real RF settlement, such as burn/transfer contracts or a custodial ledger, including idempotent transaction handling, confirmations and reorg handling. Every UI surface that currently says *SIMULATED RF* would need a matching real-transaction confirmation step.
- Media storage and CDN, moderation queue, reporting and takedown tooling for billboards
- Confirm the family ↔ district mapping and artwork licensing in `src/config/districtIdentity.ts`, and replace approximate population metadata with an authoritative, live participation source
- A spatial index or tile service for wards and plots so clients stream only what is near the camera, plus an index for Friend ID → property search
- Anti-abuse rules for contribution sniping and wash patterns, and rate limits on rally pings
