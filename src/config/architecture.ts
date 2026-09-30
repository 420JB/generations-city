import type { FixtureId } from './fixtures'

/** Curated, modular architecture. Only the building owner may change these. */
export interface ArchitectureConfig {
  facade: string
  roof: string
  windows: string
  entrance: string
  crest: string
  rooftop: string
  lighting: string
}
export type ArchitectureSlot = keyof ArchitectureConfig

export interface ArchOption {
  id: string
  label: string
  minTier?: number
  minArchitectLevel?: number
  requiresFixture?: FixtureId
}

export interface FacadePalette {
  left: string
  right: string
  top: string
  trim: string
}

export const FACADE_PALETTES: Record<string, FacadePalette> = {
  slate: { left: '#2c3547', right: '#3b475e', top: '#56627a', trim: '#8391ab' },
  limestone: { left: '#6f685d', right: '#8d8577', top: '#aaa293', trim: '#d9cfbb' },
  brick: { left: '#5a3026', right: '#7a4436', top: '#935a49', trim: '#c98e73' },
  obsidian: { left: '#12151f', right: '#1d2230', top: '#2c3345', trim: '#6c7a9c' },
  copper: { left: '#8a4a28', right: '#b86b3c', top: '#cf8a5a', trim: '#6fd1b8' },
  jade: { left: '#1f574c', right: '#2f7d6d', top: '#46a18e', trim: '#b4f0dc' },
  aurora: { left: '#27406a', right: '#3c5f8f', top: '#5f86bb', trim: '#b7e3ff' },
}

export const LIGHTING_COLORS: Record<string, { window: string; accent: string }> = {
  warm: { window: '#ffd48a', accent: '#ffb34d' },
  cool: { window: '#bfe6ff', accent: '#7cc8ff' },
  neon: { window: '#ff9df0', accent: '#5ff3ff' },
  gold: { window: '#ffe9a8', accent: '#ffc933' },
}

export const ARCH_OPTIONS: Record<ArchitectureSlot, readonly ArchOption[]> = {
  facade: [
    { id: 'slate', label: 'Slate' },
    { id: 'limestone', label: 'Limestone' },
    { id: 'brick', label: 'Brick' },
    { id: 'obsidian', label: 'Obsidian', minArchitectLevel: 2 },
    { id: 'copper', label: 'Copper', requiresFixture: 'premium-facade' },
    { id: 'jade', label: 'Jade', requiresFixture: 'premium-facade' },
    { id: 'aurora', label: 'Aurora Glass', requiresFixture: 'premium-facade', minTier: 4 },
  ],
  roof: [
    { id: 'flat', label: 'Flat Deck' },
    { id: 'terrace', label: 'Terrace', minTier: 2 },
    { id: 'dome', label: 'Dome', minTier: 2, minArchitectLevel: 1 },
    { id: 'spire', label: 'Spire', minTier: 3 },
    { id: 'crown-deck', label: 'Crown Deck', minTier: 3, requiresFixture: 'premium-roof' },
    { id: 'halo', label: 'Halo', minTier: 4, requiresFixture: 'premium-roof' },
  ],
  windows: [
    { id: 'grid', label: 'Grid' },
    { id: 'ribbon', label: 'Ribbon' },
    { id: 'arched', label: 'Arched', minArchitectLevel: 1 },
    { id: 'lattice', label: 'Lattice', minArchitectLevel: 2 },
    { id: 'panoramic', label: 'Panoramic', minTier: 4 },
  ],
  entrance: [
    { id: 'simple', label: 'Simple' },
    { id: 'awning', label: 'Awning' },
    { id: 'arch', label: 'Arch', requiresFixture: 'entrance-upgrade' },
    { id: 'portico', label: 'Grand Portico', minTier: 3, requiresFixture: 'entrance-upgrade' },
  ],
  crest: [
    { id: 'none', label: 'None' },
    { id: 'star', label: 'Star', requiresFixture: 'crest' },
    { id: 'leaf', label: 'Leaf', requiresFixture: 'crest' },
    { id: 'wave', label: 'Wave', requiresFixture: 'crest' },
    { id: 'sun', label: 'Sun', requiresFixture: 'crest' },
  ],
  rooftop: [
    { id: 'none', label: 'None' },
    { id: 'antenna', label: 'Antenna' },
    { id: 'garden', label: 'Roof Garden', minArchitectLevel: 1 },
    { id: 'beacon', label: 'Beacon Light', minArchitectLevel: 3 },
    { id: 'helipad', label: 'Helipad', minTier: 4 },
    { id: 'sign', label: 'Rooftop Sign', requiresFixture: 'rooftop-sign' },
  ],
  lighting: [
    { id: 'warm', label: 'Warm' },
    { id: 'cool', label: 'Cool' },
    { id: 'neon', label: 'Neon', minArchitectLevel: 2 },
    { id: 'gold', label: 'Gold', minArchitectLevel: 4 },
  ],
}

export const ARCH_SLOT_LABELS: Record<ArchitectureSlot, string> = {
  facade: 'Facade',
  roof: 'Roof',
  windows: 'Windows',
  entrance: 'Entrance',
  crest: 'Crest',
  rooftop: 'Rooftop Fixture',
  lighting: 'Lighting',
}

export const DEFAULT_ARCHITECTURE: ArchitectureConfig = {
  facade: 'slate',
  roof: 'flat',
  windows: 'grid',
  entrance: 'simple',
  crest: 'none',
  rooftop: 'none',
  lighting: 'warm',
}
