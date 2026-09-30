import { getBadge } from '../config/badges'
import { getDistrict } from '../config/districts'
import { DEMO_PLAYER_ID, friendLabel } from '../config/identity'
import { getMonument } from '../config/monuments'
import { badgeLabel, districtName, districtTitle } from '../game/narration'
import { wardName } from '../game/allocation'
import type { GameEvent, GameState } from '../game/types'

export interface Announcement {
  key: string
  kind: 'monument' | 'capital' | 'crown' | 'tier' | 'growth'
  title: string
  body: string
  color: string
}

export interface BadgeToast {
  key: string
  label: string
  glyph: string
}

export function announcementsFor(game: GameState, events: GameEvent[], seq: number): { banners: Announcement[]; badges: BadgeToast[] } {
  const banners: Announcement[] = []
  const badges: BadgeToast[] = []
  events.forEach((e, i) => {
    const key = `${seq}-${i}`
    if (e.type === 'monument-transfer') {
      const m = getMonument(e.monumentId)
      banners.push({
        key,
        kind: 'monument',
        title: e.from ? 'MONUMENT CAPTURED' : 'MONUMENT CLAIMED',
        body: `${m.name}: ${e.from ? `${districtName(e.from)} → ` : ''}${districtName(e.to)}`,
        color: e.to ? getDistrict(e.to).color : '#999',
      })
    } else if (e.type === 'capital-change') {
      banners.push({ key, kind: 'capital', title: 'NEW CAPITAL', body: `The ${districtTitle(e.to)} takes City Hall from ${districtName(e.from)}`, color: e.to ? getDistrict(e.to).color : '#999' })
    } else if (e.type === 'crown-transfer') {
      const b = e.to ? game.buildings[e.to] : null
      banners.push({ key, kind: 'crown', title: 'CITY CROWN TRANSFERRED', body: b ? `${friendLabel(b.friendId)} is now the tallest building` : 'Crown vacant', color: '#ffd45a' })
    } else if (e.type === 'tier-up' && e.byUserId === DEMO_PLAYER_ID) {
      const b = game.buildings[e.buildingId]
      banners.push({ key, kind: 'tier', title: `TIER ${e.toTier} REACHED`, body: `${friendLabel(b.friendId)} · ${districtName(b.districtId)}`, color: getDistrict(b.districtId).color })
    } else if (e.type === 'ward-opened') {
      banners.push({ key, kind: 'growth', title: 'THE CITY GROWS', body: `The ${districtTitle(e.districtId)} opens ${wardName(e.ward)}`, color: getDistrict(e.districtId).color })
    } else if (e.type === 'badge' && e.userId === DEMO_PLAYER_ID) {
      badges.push({ key, label: badgeLabel(e.badgeId, e.level), glyph: getBadge(e.badgeId)?.glyph ?? '★' })
    }
  })
  return { banners, badges }
}
