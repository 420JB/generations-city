/**
 * Physical layout of Rare City in WORLD UNITS (renderer-independent).
 *
 * City -> District (9, permanent family geography)
 *      -> Ward (neighbourhood band; ward 0 is the district core, more open outward)
 *      -> Plot (a building site inside a ward)
 *      -> Building (created when a Friend becomes active in the city)
 *
 * Both the strategic SVG map and any future 3D renderer consume these numbers.
 */
export const WORLD = {
  /** Central Capital Plaza radius. */
  plazaRadius: 16,
  /** Outer edge of the ring road around the plaza. */
  ringRoadOuter: 22,
  /** Each district owns a 40° wedge. */
  districtSpanDeg: 40,
  /** Angle reserved on each side of a wedge for the boundary avenue + margins. */
  districtMarginDeg: 3,
  /** The civic square (monument plaza) at the heart of each district core. */
  civicSquare: { inner: 24, outer: 38, center: 31 },
  /**
   * Ward bands. Ward 0 (Founding Ward) starts just outside the civic square; every
   * ward N is derived procedurally from its index, so there is no fixed ward limit.
   */
  coreWard: { inner: 22, outer: 64 },
  /** Radius where building plots of Ward 0 begin (civic square + its street stay clear). */
  firstPlotRadius: 40,
  /** Radial depth of every ward's plot band. */
  wardDepth: 24,
  /**
   * Two back-to-back rows, a street, two more rows: offsets from the band's plot edge.
   * Rows are 5.5 apart (lots back onto each other); the middle street is ~7 wide.
   */
  wardRowOffsets: [3, 8.5, 15.5, 21],
  /** Street radius offset inside each ward band (between the row pairs). */
  wardStreetOffset: 12,
  /** Minimum arc distance between plot centres (small lots = dense blocks). */
  plotSpacing: 5.2,
} as const
