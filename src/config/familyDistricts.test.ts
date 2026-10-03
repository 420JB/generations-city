import { describe, expect, it } from 'vitest'
import { DISTRICT_IDS } from './districts'
import { DISTRICT_FAMILY, FAMILIES } from './districtIdentity'
import { districtForFamily, FAMILY_DISTRICTS, familyForDistrict } from './familyDistricts'
import { RARE_FRIENDS_FAMILIES } from './rareFriends'

describe('registry family -> district', () => {
  it('is exactly the published table', () => {
    const table = RARE_FRIENDS_FAMILIES.map((name, id) => `${id} ${name} ${districtForFamily(id)}`)
    expect(table).toEqual(['0 Skeleton d8', '1 Mask d6', '2 Family d4', '3 Cellular d5', '4 Asymmetry d7', '5 Hoverer d9', '6 Colossus d3', '7 Sparkling d2', '8 Hollow d1'])
  })

  it('agrees with the district identity the city is drawn from', () => {
    // Derived independently: the district whose family carries that registry name.
    RARE_FRIENDS_FAMILIES.forEach((name, id) => {
      const drawn = DISTRICT_IDS.find((d) => FAMILIES[DISTRICT_FAMILY[d]].name === name)
      expect(districtForFamily(id), name).toBe(drawn)
    })
  })

  it('is one-to-one over the nine districts, and never guesses', () => {
    expect([...FAMILY_DISTRICTS].sort()).toEqual([...DISTRICT_IDS].sort())
    for (const d of DISTRICT_IDS) expect(districtForFamily(familyForDistrict(d))).toBe(d)
    for (const bad of [-1, 9, 1.5, Number.NaN, '2', null, undefined, {}]) expect(districtForFamily(bad), String(bad)).toBeNull()
    for (const bad of ['d0', 'd10', 'D4', '', null, 4]) expect(familyForDistrict(bad), String(bad)).toBeNull()
  })
})
