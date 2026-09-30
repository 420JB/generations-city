import { BILLBOARD_MAX_UPLOAD_BYTES, BILLBOARD_MIME_TYPES, BILLBOARD_OUTPUT } from '../config/economy'
import { FRAME, sourceRect, type Framing } from './billboardCrop'

export interface BillboardSource {
  /** Browser-local working copy (downscaled) used while editing. */
  src: string
  width: number
  height: number
}

const WORKING_MAX_EDGE = 1600

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const el = new Image()
    el.onload = () => resolve(el)
    el.onerror = () => reject(new Error('Could not read that image.'))
    el.src = url
  })
}

/** Validate an upload and produce a downscaled working copy for the framing editor. */
export async function loadBillboardFile(file: File): Promise<BillboardSource> {
  if (!(BILLBOARD_MIME_TYPES as readonly string[]).includes(file.type)) throw new Error('Use a JPEG, PNG or WebP image.')
  if (file.size > BILLBOARD_MAX_UPLOAD_BYTES) throw new Error('Image must be 5 MB or smaller.')
  const url = URL.createObjectURL(file)
  try {
    return await sourceFromUrl(url)
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** Working copy from any image URL (also used to re-frame the currently saved billboard). */
export async function sourceFromUrl(url: string): Promise<BillboardSource> {
  const img = await loadImage(url)
  const k = Math.min(1, WORKING_MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight))
  const w = Math.max(1, Math.round(img.naturalWidth * k))
  const h = Math.max(1, Math.round(img.naturalHeight * k))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas unavailable.')
  ctx.drawImage(img, 0, 0, w, h)
  return { src: canvas.toDataURL('image/jpeg', 0.9), width: w, height: h }
}

/** Bake the framed crop into a compressed JPEG sized for the billboard surface. */
export async function renderBillboard(source: BillboardSource, framing: Framing, scale = 1, quality: number = BILLBOARD_OUTPUT.quality): Promise<string> {
  const img = await loadImage(source.src)
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(FRAME.w * scale)
  canvas.height = Math.round(FRAME.h * scale)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas unavailable.')
  const r = sourceRect(framing, source.width, source.height)
  ctx.fillStyle = '#0b0f1c'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(img, r.sx, r.sy, r.sw, r.sh, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL('image/jpeg', quality)
}
