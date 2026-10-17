import { describe, expect, it } from 'vitest'
import type { ProofyRuleRef } from './config'
import { mayAct, previewClaimAccess, type PreviewMember } from './eligibility'

const rule: ProofyRuleRef = { source: 'sample', verificationRuleId: 9001, label: 'Captain' }
const member = (answers: PreviewMember['answers']): PreviewMember => ({ id: 'm', label: 'M', answers })

describe('district access (presentation only)', () => {
  it('a visitor can never act, gate or not', () => {
    expect(previewClaimAccess(null, null)).toEqual({ kind: 'visitor' })
    expect(previewClaimAccess(rule, null)).toEqual({ kind: 'visitor' })
    expect(mayAct({ kind: 'visitor' })).toBe(false)
  })

  it('no gate: every member may act', () => {
    expect(previewClaimAccess(null, member({}))).toEqual({ kind: 'open' })
    expect(mayAct(previewClaimAccess(null, member({ 9001: false })))).toBe(true)
  })

  it('a gate needs a true answer; false and unknown both fail closed', () => {
    expect(previewClaimAccess(rule, member({ 9001: true }))).toEqual({ kind: 'eligible', rule })
    expect(previewClaimAccess(rule, member({ 9001: false }))).toEqual({ kind: 'restricted', rule, reason: 'not-qualified' })
    expect(previewClaimAccess(rule, member({ 9001: null }))).toEqual({ kind: 'restricted', rule, reason: 'unknown' })
    expect(previewClaimAccess(rule, member({ 42: true }))).toEqual({ kind: 'restricted', rule, reason: 'unknown' })
    expect(mayAct(previewClaimAccess(rule, member({ 9001: null })))).toBe(false)
  })

  it('an inherited property cannot stand in for an answer', () => {
    const answers = Object.create({ 9001: true }) as PreviewMember['answers']
    expect(previewClaimAccess(rule, member(answers)).kind).toBe('restricted')
  })
})
