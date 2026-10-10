import type { PlotAddress } from '../game/allocation'
import { plotId } from '../game/world'

/**
 * HOW A PLOT IS SHOWN TO A PERSON.
 *
 * Protocol plot ids count from zero (`d8-w0-p0`). People count from one, so the same plot is
 * shown as Ward 1, Plot 1. This is the one place the two are related: the numbers here are
 * for reading only, and what is sent to the server is always `protocolId`, unchanged.
 */
export interface PlotDisplay {
  /** One-based, for people. */
  ward: number
  /** One-based, for people. */
  plot: number
  /** "Ward 1 · Plot 1". */
  label: string
  /** The exact zero-based protocol id. Technical detail, and the only form the server is sent. */
  protocolId: string
}

/** "Ward 1 · Plot 1" for the zero-based ward 0, plot 0. */
export function plotLabel(site: { ward: number; plot: number }): string {
  return `Ward ${site.ward + 1} · Plot ${site.plot + 1}`
}

export function plotDisplay(address: PlotAddress): PlotDisplay {
  return { ward: address.ward + 1, plot: address.plot + 1, label: plotLabel(address), protocolId: plotId(address.districtId, address.ward, address.plot) }
}
