import { describe, expect, it } from 'vitest'
import { parsePlotId } from '../protocol/activation'
import { plotDisplay, plotLabel } from './display'

describe('how a plot is shown to a person', () => {
  it('shows the zero-based protocol plot w0/p0 as Ward 1 · Plot 1', () => {
    expect(plotDisplay({ districtId: 'd8', ward: 0, plot: 0 })).toEqual({ ward: 1, plot: 1, label: 'Ward 1 · Plot 1', protocolId: 'd8-w0-p0' })
    expect(plotLabel({ ward: 0, plot: 0 })).toBe('Ward 1 · Plot 1')
  })

  it('never shows a Ward 0 or a Plot 0, and never changes the protocol id', () => {
    for (const [ward, plot] of [[0, 0], [0, 7], [1, 0], [3, 12], [41, 199]]) {
      const shown = plotDisplay({ districtId: 'd4', ward, plot })
      expect([shown.ward, shown.plot]).toEqual([ward + 1, plot + 1])
      expect(shown.label).toBe(`Ward ${ward + 1} · Plot ${plot + 1}`)
      expect(shown.label).not.toMatch(/\b(Ward|Plot) 0\b/)
      // The protocol id is the zero-based one, and reads back to exactly the plot that was shown.
      expect(shown.protocolId).toBe(`d4-w${ward}-p${plot}`)
      expect(parsePlotId(shown.protocolId)).toEqual({ districtId: 'd4', ward, plot, plotId: shown.protocolId })
    }
  })
})
