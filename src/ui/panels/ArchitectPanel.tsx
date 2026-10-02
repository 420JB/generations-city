import { useCallback, useEffect, useState } from 'react'
import { ARCH_OPTIONS, ARCH_SLOT_LABELS, FACADE_PALETTES, LIGHTING_COLORS, type ArchitectureSlot } from '../../config/architecture'
import { ARCHITECT_LEVELS, BILLBOARD_MIN_TIER, LANDSCAPE_MAX_SLOTS } from '../../config/economy'
import { FIXTURES, LANDSCAPE_KINDS, getFixture, type FixtureId, type LandscapeKind } from '../../config/fixtures'
import { friendLabel } from '../../config/identity'
import { optionUnlocked } from '../../game/actions'
import { architectLevel, buildSplit, formatRF, landscapeCapacity, nextArchitectThreshold, tierFor } from '../../game/economy'
import type { GameState } from '../../game/types'
import { PanelHeader, ProgressBar, SimTag } from '../common'
import { loadBillboardFile, sourceFromUrl, type BillboardSource } from '../image'
import { BillboardEditor } from './BillboardEditor'
import { MEDIA_TIERS, mediaTierFor } from '../../config/media'
import type { GameAction } from '../store'
import { BILLBOARD_MESSAGE_MAX, validateBillboardMessage } from '../../game/media'

type Tab = 'design' | 'fixtures' | 'landscape' | 'billboard'

const LS_ICON: Record<LandscapeKind, string> = { tree: '🌳', shrub: '🌿', planter: '🪴', bench: '🪑', lamp: '💡' }

interface Props {
  game: GameState
  viewerId: string
  buildingId: string
  act: (a: GameAction) => void
  onClose: () => void
  onBack: () => void
  /** Live, unsaved billboard preview on the building (null clears it). */
  onBillboardDraft: (image: string | null) => void
}

export function ArchitectPanel({ game, viewerId, buildingId, act, onClose, onBack, onBillboardDraft }: Props) {
  const b = game.buildings[buildingId]
  const [tab, setTab] = useState<Tab>('design')
  const [buying, setBuying] = useState<FixtureId | null>(null)
  const [pickSlot, setPickSlot] = useState<number | null>(null)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const savedMessage = b.billboard.message ?? ''
  const [msgDraft, setMsgDraft] = useState(savedMessage)
  const [msgError, setMsgError] = useState<string | null>(null)
  const saveMessage = (raw: string) => {
    const v = validateBillboardMessage(raw)
    if (!v.ok) {
      setMsgError(v.error)
      return
    }
    setMsgError(null)
    setMsgDraft(v.value ?? '')
    act({ type: 'billboard-message', buildingId, message: v.value ?? '' })
  }
  const [editing, setEditing] = useState<BillboardSource | null>(null)
  // Never leave an unsaved preview on the building after the panel closes.
  useEffect(() => () => onBillboardDraft(null), [onBillboardDraft])
  const onDraft = useCallback((img: string) => onBillboardDraft(img), [onBillboardDraft])
  if (b.ownerId !== viewerId) return null
  const split = buildSplit(b)
  const tier = tierFor(split.total)
  const lvl = architectLevel(b.ownerBuilt)
  const next = nextArchitectThreshold(b.ownerBuilt)
  const cap = landscapeCapacity(b.ownerBuilt)
  const wallet = game.wallets[viewerId] ?? 0

  const buy = (id: FixtureId) => {
    act({ type: 'fixture', buildingId, fixtureId: id })
    setBuying(null)
  }

  const onFile = async (file: File | undefined) => {
    if (!file) return
    setUploadError(null)
    setBusy(true)
    try {
      setEditing(await loadBillboardFile(file))
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : 'Upload failed.')
    } finally {
      setBusy(false)
    }
  }

  const reframe = async () => {
    if (!b.billboard.image) return
    setUploadError(null)
    setBusy(true)
    try {
      setEditing(await sourceFromUrl(b.billboard.image))
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : 'Could not open image.')
    } finally {
      setBusy(false)
    }
  }
  const closeEditor = () => {
    setEditing(null)
    onBillboardDraft(null)
  }

  const clickSlot = (i: number) => {
    if (i >= cap) return
    if (pickSlot === null) {
      setPickSlot(i)
    } else if (pickSlot === i) {
      setPickSlot(null)
    } else {
      act({ type: 'landscape-swap', buildingId, a: pickSlot, b: i })
      setPickSlot(null)
    }
  }

  const fixtureRow = (id: FixtureId) => {
    const f = getFixture(id)
    const owned = !f.repeatable && b.fixtures.includes(id)
    const locked = tier < f.minTier
    return (
      <li key={id} className={`fixture${owned ? ' owned' : ''}`} data-testid={`fixture-${id}`}>
        <div className="grow">
          <div className="strong">{f.name}</div>
          <div className="muted small">{f.description}</div>
        </div>
        {owned ? (
          <span className="owned-tag">Installed</span>
        ) : buying === id ? (
          <div className="confirm-inline">
            <div className="small">
              <b>{formatRF(f.price)}</b> SIMULATED RF · No real tokens move.
            </div>
            <div className="row gap">
              <button type="button" className="btn primary sm" onClick={() => buy(id)} data-testid={`confirm-fixture-${id}`}>
                Confirm
              </button>
              <button type="button" className="btn ghost sm" onClick={() => setBuying(null)}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button type="button" className="btn sm" disabled={locked || f.price > wallet} onClick={() => setBuying(id)} title={locked ? `Requires Tier ${f.minTier}` : undefined} data-testid={`buy-${id}`}>
            {locked ? `T${f.minTier}+` : `${formatRF(f.price)} RF`}
          </button>
        )}
      </li>
    )
  }

  return (
    <section className="panel architect-panel" aria-label="Architect Mode" data-testid="architect-panel">
      <PanelHeader kicker={`ARCHITECT MODE · ${friendLabel(b.friendId)}`} title="Design your building" onClose={onClose} onBack={onBack} />
      <div className="arch-level">
        <div className="row-between">
          <span>
            Architect Level <b data-testid="architect-level">{lvl}</b>
          </span>
          <span className="muted small">{next ? `${formatRF(next - b.ownerBuilt)} owner RF to Lv ${lvl + 1}` : 'Max level'}</span>
        </div>
        <ProgressBar value={next ? (b.ownerBuilt - ARCHITECT_LEVELS[lvl]) / (next - ARCHITECT_LEVELS[lvl]) : 1} color="#5ff3d6" label="Architect progress" />
        <p className="muted small">
          <b className="accent">Customization is construction.</b> Every fixture you buy adds to Owner Build <i>and</i> Total Build. Owner Built:{' '}
          <b data-testid="arch-owner-built">{formatRF(split.owner)}</b> · Total: <b data-testid="arch-total-built">{formatRF(split.total)}</b>
        </p>
      </div>
      <div className="tabs" role="tablist">
        {(['design', 'fixtures', 'landscape', 'billboard'] as Tab[]).map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} className={`tab${tab === t ? ' on' : ''}`} onClick={() => setTab(t)} data-testid={`tab-${t}`}>
            {t === 'design' ? 'Design' : t === 'fixtures' ? 'Fixtures' : t === 'landscape' ? 'Landscape' : 'Billboard'}
          </button>
        ))}
      </div>

      {tab === 'design' && (
        <div className="design-grid">
          {(Object.keys(ARCH_OPTIONS) as ArchitectureSlot[]).map((slot) => (
            <div key={slot} className="design-row">
              <div className="kicker">{ARCH_SLOT_LABELS[slot]}</div>
              <div className="chip-row">
                {ARCH_OPTIONS[slot].map((o) => {
                  const u = optionUnlocked(b, slot, o.id)
                  const on = b.architecture[slot] === o.id
                  const swatch = slot === 'facade' ? FACADE_PALETTES[o.id]?.right : slot === 'lighting' ? LIGHTING_COLORS[o.id]?.window : undefined
                  return (
                    <button
                      key={o.id}
                      type="button"
                      className={`chip${on ? ' on' : ''}${u.ok ? '' : ' locked'}`}
                      aria-pressed={on}
                      disabled={!u.ok}
                      title={u.reason}
                      onClick={() => act({ type: 'architecture', buildingId, slot, optionId: o.id })}
                      data-testid={`arch-${slot}-${o.id}`}
                    >
                      {swatch && <i className="swatch" style={{ background: swatch }} />}
                      {o.label}
                      {!u.ok && <span className="lock"> 🔒</span>}
                    </button>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      {tab === 'fixtures' && (
        <div>
          <div className="row-between">
            <h3>Fixture catalog</h3>
            <SimTag />
          </div>
          <ul className="fixture-list">{FIXTURES.map((f) => fixtureRow(f.id))}</ul>
        </div>
      )}

      {tab === 'landscape' && (
        <div>
          <p className="muted small">
            {cap} of {LANDSCAPE_MAX_SLOTS} lot slots unlocked (grows with Architect Level). Select a slot, then another slot to swap, or place an item from inventory.
          </p>
          <div className="slot-grid" data-testid="landscape-slots">
            {Array.from({ length: LANDSCAPE_MAX_SLOTS }, (_, i) => {
              const item = b.landscapeSlots[i]
              const locked = i >= cap
              return (
                <button
                  key={i}
                  type="button"
                  className={`slot${pickSlot === i ? ' picked' : ''}${locked ? ' locked' : ''}`}
                  disabled={locked}
                  onClick={() => clickSlot(i)}
                  aria-label={`Slot ${i + 1}: ${locked ? 'locked' : item ?? 'empty'}`}
                  data-testid={`slot-${i}`}
                  data-item={item ?? ''}
                >
                  {locked ? '🔒' : item ? LS_ICON[item] : '＋'}
                  <span>{locked ? 'Locked' : item ?? 'Empty'}</span>
                </button>
              )
            })}
          </div>
          {pickSlot !== null && (
            <div className="slot-actions">
              <span className="small">Slot {pickSlot + 1}:</span>
              {LANDSCAPE_KINDS.map((k) => (
                <button key={k} type="button" className="chip" disabled={(b.landscapeInventory[k] ?? 0) < 1} onClick={() => { act({ type: 'landscape-place', buildingId, slot: pickSlot, kind: k }); setPickSlot(null) }} data-testid={`place-${k}`}>
                  {LS_ICON[k]} {k} ×{b.landscapeInventory[k] ?? 0}
                </button>
              ))}
              {b.landscapeSlots[pickSlot] && (
                <button type="button" className="chip" onClick={() => { act({ type: 'landscape-place', buildingId, slot: pickSlot, kind: null }); setPickSlot(null) }}>
                  Remove
                </button>
              )}
            </div>
          )}
          <div className="inventory small">
            Inventory:{' '}
            {LANDSCAPE_KINDS.map((k) => (
              <span key={k} className="inv">
                {LS_ICON[k]} {b.landscapeInventory[k] ?? 0}
              </span>
            ))}
          </div>
          <ul className="fixture-list">{FIXTURES.filter((f) => f.kind === 'landscape').map((f) => fixtureRow(f.id))}</ul>
        </div>
      )}

      {tab === 'billboard' && (
        <div className="billboard-tab">
          <div className="kicker">PROPERTY MEDIA LADDER · YOUR TOWER, YOUR MEDIA</div>
          <ul className="media-ladder" data-testid="media-ladder">
            {MEDIA_TIERS.map((m) => (
              <li key={m.id} className={mediaTierFor(tier)?.id === m.id ? 'on' : tier < m.minTier ? 'locked' : ''}>
                <b>T{m.minTier}</b>
                <span className="grow">
                  <b>{m.label}</b> <span className="muted">· {m.description}</span>
                </span>
                {mediaTierFor(tier)?.id === m.id && <span className="rep-tag">CURRENT</span>}
              </li>
            ))}
          </ul>
          {!b.fixtures.includes('billboard') ? (
            <>
              <p className="muted small">
                Tier {BILLBOARD_MIN_TIER}+ buildings can install one controlled billboard surface. The purchase counts toward Owner and Total Build.
              </p>
              <ul className="fixture-list">{fixtureRow('billboard')}</ul>
            </>
          ) : (
            <>
              {editing ? (
                <BillboardEditor
                  source={editing}
                  onDraft={onDraft}
                  onCancel={closeEditor}
                  onSave={(image) => {
                    act({ type: 'billboard', buildingId, image })
                    closeEditor()
                  }}
                />
              ) : (
                <>
                  <div className="bb-preview" data-testid="billboard-preview">
                    {b.billboard.image ? <img src={b.billboard.image} alt="Your billboard" /> : <span>No image yet</span>}
                  </div>
                  <div className="row gap wrap">
                    <label className="btn primary sm file-btn">
                      {busy ? 'Processing…' : b.billboard.image ? 'Replace Image' : 'Upload Image'}
                      <input type="file" accept="image/jpeg,image/png,image/webp" onChange={(e) => { void onFile(e.target.files?.[0]); e.target.value = '' }} data-testid="billboard-input" />
                    </label>
                    {b.billboard.image && (
                      <button type="button" className="btn sm" onClick={() => void reframe()} data-testid="billboard-reframe">
                        Adjust framing
                      </button>
                    )}
                    {b.billboard.image && (
                      <button type="button" className="btn ghost sm" onClick={() => act({ type: 'billboard', buildingId, image: null })} data-testid="billboard-remove">
                        Remove Image
                      </button>
                    )}
                  </div>
                </>
              )}
              {uploadError && <p className="error small" role="alert">{uploadError}</p>}
              <div className="bb-message-editor">
                <label htmlFor="bb-message" className="kicker">
                  OWNER MESSAGE · OPTIONAL · PLAIN TEXT, NO LINKS
                </label>
                <textarea
                  id="bb-message"
                  rows={3}
                  maxLength={BILLBOARD_MESSAGE_MAX}
                  value={msgDraft}
                  placeholder="e.g. Rare Friends meetup tonight · Follow @example"
                  onChange={(e) => {
                    setMsgDraft(e.target.value)
                    setMsgError(null)
                  }}
                  aria-invalid={msgError ? true : undefined}
                  aria-describedby="bb-message-help"
                  data-testid="billboard-message-input"
                />
                <div className="row-between small" id="bb-message-help">
                  <span className="muted">Shown when someone opens your billboard. Name a project or @handle; URLs are blocked.</span>
                  <span className="muted" data-testid="billboard-message-count">
                    {msgDraft.trim().length}/{BILLBOARD_MESSAGE_MAX}
                  </span>
                </div>
                {msgError && (
                  <p className="error small" role="alert" data-testid="billboard-message-error">
                    {msgError}
                  </p>
                )}
                <div className="row gap">
                  <button type="button" className="btn sm primary" disabled={msgDraft.trim() === savedMessage} onClick={() => saveMessage(msgDraft)} data-testid="billboard-message-save">
                    Save message
                  </button>
                  {savedMessage && (
                    <button type="button" className="btn ghost sm" onClick={() => saveMessage('')} data-testid="billboard-message-clear">
                      Remove message
                    </button>
                  )}
                </div>
              </div>
              <p className="muted small">
                JPEG, PNG or WebP up to 5 MB. Images are cropped to the billboard surface, compressed in your browser and stored only in this browser&apos;s local demo state. A production version would require server storage plus moderation, reporting and content controls.
              </p>
            </>
          )}
        </div>
      )}
    </section>
  )
}
