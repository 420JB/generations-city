import { uuidV8FromText } from '../../world/property'
import { BRAND_LIMITS, parseBrandCityConfig, type ConfigProblem, type ParsedBrandConfig } from './config'
import { BRAND_MEDIA_PREFIX } from './media'

/**
 * RARE CITY'S PROOFY PLAY CONFIGURATION, schema version 1.
 *
 * Proofy Play stores each installation's configuration as immutable numbered versions,
 * validated against a JSON Schema the game registers (`PUT /v1/game/config-schemas/{v}`,
 * Play contract 1.1.0 §4.3). This module is that schema, plus Rare City's own reading of a
 * document Play has served, which maps it onto `BrandCityConfig`.
 *
 * The document holds exactly the brand surface (`config.ts`): names, logo and crest, the
 * collections, and per district a name, an accent, an optional Monument NFT and an optional
 * Proofy rule reference. Anything else (camera, roads, building styles, balance, economy) is
 * refused, by Play's schema and again here: every object is closed.
 *
 * What the document deliberately does NOT carry:
 *   - the world id. A world belongs to an installation; an admin never chooses or moves it.
 *   - media outside Rare City's approved `/brand-media/` set. Play's asset references
 *     (`{ url, sha256, contentType, bytes }`) need a media proxy that does not exist yet, and
 *     data: URLs would spend most of Play's 64 KiB limit; a later schema version can add them.
 *
 * Schema versions are immutable once registered with Play, so a change here is a new version.
 */
export const PLAY_GAME_KEY = 'rare-city'
export const PLAY_CONFIG_SCHEMA_VERSION = 1
/** Play schema versions this build can read. A run pinned to any other version is refused. */
export const SUPPORTED_PLAY_SCHEMA_VERSIONS: readonly number[] = [PLAY_CONFIG_SCHEMA_VERSION]

/** Proofy Core `verification_rules.id` is a Postgres `serial`: 1 to 2^31 - 1. */
export const MAX_VERIFICATION_RULE_ID = 2_147_483_647

const text = (max: number) => ({ type: 'string', minLength: 1, maxLength: max })

/**
 * The `/brand-media/` paths `vetMediaRef` (media.ts) accepts, as one JSON Schema pattern, so
 * Play refuses at save time exactly what Rare City would refuse at launch. Each segment starts
 * with a letter or digit (so no `//`, no `.hidden`), and a dot is always followed by another
 * path character, so `..` cannot occur anywhere; a directory may end in one dot (`a./`), as
 * `vetMediaRef` allows. Spelled without lookahead, which Play's RE2 patterns refuse.
 */
const SEGMENT = '[A-Za-z0-9](?:\\.?[A-Za-z0-9_-])*'
export const PLAY_MEDIA_PATTERN = `^/brand-media/(?:${SEGMENT}\\.?/)*${SEGMENT}\\.(?:png|jpg|jpeg|webp|svg)$`
const media = { type: ['string', 'null'], maxLength: 200, pattern: PLAY_MEDIA_PATTERN }

/** The JSON Schema (Draft 2020-12, within Play's bounded subset) registered as schema version 1. */
export const PLAY_CONFIG_JSON_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'Rare City brand city',
  description: 'The brand surface of a Rare City installation: names, media, NFT collections, districts. Layout, art, camera and game mechanics are standard and not configurable.',
  type: 'object',
  additionalProperties: false,
  required: ['cityName', 'brand', 'capital', 'collections', 'districts'],
  properties: {
    cityName: text(BRAND_LIMITS.nameLength),
    brand: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'logo'],
      properties: { name: text(BRAND_LIMITS.nameLength), logo: { $ref: '#/$defs/media' } },
    },
    capital: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'crest'],
      properties: { name: text(BRAND_LIMITS.nameLength), crest: { $ref: '#/$defs/media' } },
    },
    collections: {
      type: 'array',
      minItems: 1,
      maxItems: BRAND_LIMITS.collections,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['key', 'chain', 'contract', 'displayName'],
        properties: {
          key: { $ref: '#/$defs/key' },
          chain: { type: 'string', maxLength: 23, pattern: '^eip155:[1-9][0-9]{0,15}$' },
          contract: { type: 'string', maxLength: 42, pattern: '^0x[0-9a-fA-F]{40}$' },
          displayName: text(BRAND_LIMITS.nameLength),
        },
      },
    },
    districts: {
      type: 'array',
      minItems: BRAND_LIMITS.minDistricts,
      maxItems: BRAND_LIMITS.maxDistricts,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['key', 'name', 'accent', 'monument', 'proofyRule'],
        properties: {
          key: { $ref: '#/$defs/key' },
          name: text(BRAND_LIMITS.nameLength),
          accent: { type: 'string', maxLength: 7, pattern: '^#[0-9a-f]{6}$' },
          monument: {
            oneOf: [
              { type: 'null' },
              {
                type: 'object',
                additionalProperties: false,
                required: ['collection', 'tokenId', 'artwork'],
                properties: {
                  collection: { $ref: '#/$defs/key' },
                  tokenId: { type: 'string', maxLength: 78, pattern: '^(?:0|[1-9][0-9]*)$' },
                  artwork: { $ref: '#/$defs/media' },
                },
              },
            ],
          },
          proofyRule: {
            oneOf: [
              { type: 'null' },
              {
                type: 'object',
                additionalProperties: false,
                required: ['verificationRuleId', 'label'],
                properties: {
                  verificationRuleId: { type: 'integer', minimum: 1, maximum: MAX_VERIFICATION_RULE_ID },
                  label: text(BRAND_LIMITS.labelLength),
                },
              },
            ],
          },
        },
      },
    },
  },
  $defs: {
    key: { type: 'string', minLength: 1, maxLength: 32, pattern: '^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$' },
    media,
  },
} as const

/** What Rare City reads from a Play configuration document (schema version 1). */
export interface PlayCityDocument {
  cityName: string
  brand: { name: string; logo: string | null }
  capital: { name: string; crest: string | null }
  collections: { key: string; chain: string; contract: string; displayName: string }[]
  districts: {
    key: string
    name: string
    accent: string
    monument: { collection: string; tokenId: string; artwork: string | null } | null
    proofyRule: { verificationRuleId: number; label: string } | null
  }[]
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

const SHAPE = {
  root: ['cityName', 'brand', 'capital', 'collections', 'districts'],
  brand: ['name', 'logo'],
  capital: ['name', 'crest'],
  collection: ['key', 'chain', 'contract', 'displayName'],
  district: ['key', 'name', 'accent', 'monument', 'proofyRule'],
  monument: ['collection', 'tokenId', 'artwork'],
  proofyRule: ['verificationRuleId', 'label'],
} as const

/**
 * Read a configuration document Play served for a run, for the world `worldId`.
 *
 * Play has already validated it against the registered schema; this does not rely on that.
 * Every object must have exactly its listed fields (nothing unknown, nothing missing), media
 * must be `/brand-media/` paths, and rule ids must fit Core's `serial`. Then the document goes
 * through `parseBrandCityConfig`, the one brand validator, which checks everything else
 * (cross-references, duplicates, text safety, limits).
 */
export function parsePlayCityConfig(document: unknown, worldId: string): ParsedBrandConfig {
  const problems: ConfigProblem[] = []
  const add = (path: string, detail: string) => problems.length < 50 && problems.push({ path, detail })
  const closed = (path: string, v: unknown, fields: readonly string[]): v is Record<string, unknown> => {
    if (!isRecord(v)) {
      add(path, 'must be an object')
      return false
    }
    for (const k of Object.keys(v)) if (!fields.includes(k)) add(path ? `${path}.${k}` : k, 'is not a configurable field')
    for (const k of fields) if (!Object.hasOwn(v, k)) add(path ? `${path}.${k}` : k, 'is required (use null for none)')
    return true
  }
  const playMedia = (path: string, v: unknown) => {
    if (v !== null && (typeof v !== 'string' || !v.startsWith(BRAND_MEDIA_PREFIX))) add(path, `must be null or a ${BRAND_MEDIA_PREFIX} path`)
  }

  if (!closed('', document, SHAPE.root)) return { ok: false, problems }
  const doc = document
  if (closed('brand', doc.brand, SHAPE.brand)) playMedia('brand.logo', doc.brand.logo)
  if (closed('capital', doc.capital, SHAPE.capital)) playMedia('capital.crest', doc.capital.crest)
  if (Array.isArray(doc.collections)) doc.collections.forEach((c, i) => closed(`collections[${i}]`, c, SHAPE.collection))
  const districts = Array.isArray(doc.districts) ? doc.districts : []
  districts.forEach((d: unknown, i: number) => {
    const path = `districts[${i}]`
    if (!closed(path, d, SHAPE.district)) return
    if (d.monument !== null && closed(`${path}.monument`, d.monument, SHAPE.monument)) playMedia(`${path}.monument.artwork`, d.monument.artwork)
    if (d.proofyRule !== null && closed(`${path}.proofyRule`, d.proofyRule, SHAPE.proofyRule)) {
      const id = d.proofyRule.verificationRuleId
      if (typeof id === 'number' && Number.isSafeInteger(id) && id > MAX_VERIFICATION_RULE_ID) add(`${path}.proofyRule.verificationRuleId`, `is above ${MAX_VERIFICATION_RULE_ID}, so it cannot be a Proofy Core verification rule id`)
    }
  })
  if (problems.length > 0) return { ok: false, problems }

  // The shape is exact; the brand validator judges the content. A Play rule reference always
  // names a rule in Proofy Core: `source: 'proofy-core'`, never a sample.
  return parseBrandCityConfig({
    worldId,
    cityName: doc.cityName,
    brand: doc.brand,
    capital: doc.capital,
    collections: doc.collections,
    districts: districts.map((d: Record<string, unknown>) => {
      const rule = d.proofyRule as Record<string, unknown> | null
      return {
        key: d.key,
        name: d.name,
        accent: d.accent,
        monument: d.monument,
        gate: rule === null ? null : { source: 'proofy-core', verificationRuleId: rule.verificationRuleId, label: rule.label },
      }
    }),
  })
}

/** Play's environment labels, as embedded in a service credential (`ppk_<env>_…`). */
export type PlayEnvironment = 'dev' | 'test' | 'staging' | 'live'

/**
 * The world id the PREVIEW uses for an installation that has no provisioned world yet.
 *
 * A real world is a `worlds` row (migration 0005) with an application-generated UUIDv7, bound
 * once to its installation. Founding one is not done here (it needs `city:verify` to become
 * world-aware first). Until then the city still needs an id for the engine, so this derives one
 * from the installation: stable across launches, different per installation and environment,
 * and a UUIDv8, so it can never be mistaken for, or collide with, a provisioned UUIDv7 world.
 * Nothing permanent may be keyed by it.
 */
export function playPreviewWorldId(environment: PlayEnvironment, installationId: string): string {
  return uuidV8FromText(`rare-city:play-preview-world:v1|env=${environment}|installation=${installationId}`)
}
