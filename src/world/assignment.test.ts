import { describe, expect, it } from 'vitest'
import { defaultRotationDistricts, resolveDistrictRules, rotationDistrict } from './assignment'

const gate = { verificationRuleId: 41, label: 'Captains' }

describe('the default district rotation (MCD 46B)', () => {
  it('is the city districts in configuration order, without the rule-gated ones', () => {
    expect(defaultRotationDistricts([{ key: 'a', gate: null }, { key: 'b', gate }, { key: 'c', gate: null }, { key: 'd', gate: undefined }])).toEqual(['a', 'c', 'd'])
    expect(defaultRotationDistricts([{ key: 'a', gate }])).toEqual([])
  })

  it('names districts 1, 2, 3 and round again, counted from the first ordinal of the epoch', () => {
    const order = ['a', 'b', 'c']
    expect([0, 1, 2, 3, 4, 5, 6].map((n) => rotationDistrict(order, 0, n))).toEqual(['a', 'b', 'c', 'a', 'b', 'c', 'a'])
    // A new epoch starting at ordinal 7 begins again at district 1.
    expect([7, 8, 9, 10].map((n) => rotationDistrict(order, 7, n))).toEqual(['a', 'b', 'c', 'a'])
    // Before the epoch, without districts, or not a safe integer: no district.
    for (const [districts, start, ordinal] of [[order, 7, 6], [[], 0, 0], [order, 0, 1.5], [order, 0, Number.MAX_SAFE_INTEGER + 1]] as const) expect(rotationDistrict(districts, start, ordinal)).toBeNull()
  })
})

describe('explicit district rules', () => {
  const city = new Set(['lantern-quay', 'tidewater', 'saltmarsh'])

  it('applies none when no rule matches, or the rules name districts this city does not have', () => {
    expect(resolveDistrictRules([], city)).toEqual({ kind: 'none' })
    expect(resolveDistrictRules([{ id: 'r', district: 'orchard' }], city)).toEqual({ kind: 'none' })
  })

  it('assigns the district every applying rule names, recording every rule id', () => {
    expect(resolveDistrictRules([{ id: 'r1', district: 'tidewater' }, { id: 'elsewhere', district: 'orchard' }], city)).toEqual({ kind: 'rule', district: 'tidewater', ruleRef: 'r1' })
    expect(resolveDistrictRules([{ id: 'z', district: 'tidewater' }, { id: 'a', district: 'tidewater' }, { id: 'a', district: 'tidewater' }], city)).toEqual({ kind: 'rule', district: 'tidewater', ruleRef: 'a,z' })
  })

  it('refuses to choose between rules naming different districts: no precedence is approved', () => {
    expect(resolveDistrictRules([{ id: 'by-collection', district: 'tidewater' }, { id: 'by-trait', district: 'lantern-quay' }], city)).toEqual({ kind: 'ambiguous', districts: ['lantern-quay', 'tidewater'] })
  })
})
