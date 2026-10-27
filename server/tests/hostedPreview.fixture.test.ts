import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseAssetKey } from '../../src/world/asset'
import { parsePlayCityConfig } from '../src/engine'
import { parseRehearsalFile, rehearsalConstructionAuthority } from '../src/world/rehearsal'

/**
 * THE SYNTHETIC PREVIEW WORLD (`hosted-preview/`): the Play configuration an operator publishes in a DEV Play, and the two
 * deterministic controller variants of the rehearsal file. Public-safe by construction: made-up ids and example contracts
 * only, so it may be committed.
 */
const dir = resolve(import.meta.dirname, '../../hosted-preview')
const read = (name: string) => JSON.parse(readFileSync(resolve(dir, name), 'utf8')) as Record<string, unknown>
const config = read('districts-preview.config.json')
const A = read('rehearsal-controller-a.json')
const B = read('rehearsal-controller-b.json')
const GUILD = '910000000000000001'
const ADA = '910000000000000101'
const BEA = '910000000000000102'
const KEEPER_101 = 'eip155:8453/erc721:0x000000000000000000000000000000000000d101/101'
const keeper101 = parseAssetKey(KEEPER_101)!

describe('hosted preview synthetic world', () => {
  it('the configuration is a valid Rare City Play configuration with unrestricted districts only', () => {
    const parsed = parsePlayCityConfig(config, '01a14800-0000-7000-8000-0000000000ff')
    expect(parsed.ok).toBe(true)
    const districts = config.districts as { proofyRule: unknown }[]
    expect(districts.length).toBeGreaterThanOrEqual(2)
    expect(districts.every((d) => d.proofyRule === null)).toBe(true)
  })

  it('both controller variants parse, open construction in the preview server and differ only in who controls keeper #101', () => {
    for (const file of [A, B]) {
      const fixture = parseRehearsalFile(file)
      const construction = rehearsalConstructionAuthority(fixture)
      expect(construction.opensIn({ guildId: GUILD })).toBe(true)
      expect(construction.grantsFor({ guildId: GUILD, discordUserId: ADA })).toEqual([{ key: 'preview-starter', units: 400 }])
    }
    expect(rehearsalConstructionAuthority(parseRehearsalFile(A)).controllerOf({ guildId: GUILD }, keeper101)).toBe(ADA)
    expect(rehearsalConstructionAuthority(parseRehearsalFile(B)).controllerOf({ guildId: GUILD }, keeper101)).toBe(BEA)
    const strip = (f: Record<string, unknown>) => ({ ...f, controllers: (f.controllers as { asset: string }[]).filter((c) => c.asset !== KEEPER_101) })
    expect(strip(A)).toEqual(strip(B))
  })

  it('every listed NFT is of a configured collection, and every id is synthetic', () => {
    const collections = (config.collections as { chain: string; contract: string }[]).map((c) => `${c.chain}/erc721:${c.contract}/`)
    const assets = [...Object.values(A.players as Record<string, string[]>).flat(), ...(A.controllers as { asset: string }[]).map((c) => c.asset)]
    for (const asset of assets) expect(collections.some((c) => asset.startsWith(c)), asset).toBe(true)
    // Example contracts (all zeros but the last two bytes) and made-up Discord ids in the 9100… range.
    for (const c of config.collections as { contract: string }[]) expect(c.contract).toMatch(/^0x0{36}[0-9a-f]{4}$/)
    const text = JSON.stringify([config, A, B])
    for (const id of text.match(/\b\d{17,20}\b/g) ?? []) expect(id, id).toMatch(/^9100000000000\d{5}$/)
    expect(text).not.toMatch(/https?:\/\//)
  })
})
