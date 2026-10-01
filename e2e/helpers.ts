import { deflateSync, inflateSync } from 'node:zlib'
import { expect, type Page } from '@playwright/test'

export const SHOTS = 'test-artifacts/screenshots'

export async function openCity(page: Page) {
  await page.goto('/')
  await expect(page.getByTestId('city')).toBeVisible()
  await expect(page.getByTestId('building-812')).toBeAttached()
}

export async function selectBuilding(page: Page, friendId: number) {
  const el = page.getByTestId(`building-${friendId}`)
  await el.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('building-panel')).toHaveAttribute('data-building', String(friendId))
}

export async function contributeExact(page: Page) {
  await page.getByTestId('amount-exact').click()
  await expect(page.getByTestId('confirm-box')).toContainText('SIMULATED RF')
  await expect(page.getByTestId('confirm-box')).toContainText('No real tokens move.')
  await page.getByTestId('confirm-contribution').click()
}

export async function warpToKingmaker(page: Page) {
  await page.getByTestId('nav-board').click()
  const card = page.getByTestId('impact-0')
  await expect(card).toHaveAttribute('data-building', '812')
  await page.getByTestId('impact-0-warp').click()
  await expect(page.getByTestId('building-panel')).toHaveAttribute('data-building', '812')
}

export async function warpToOwnBuilding(page: Page) {
  await page.getByTestId('nav-profile').click()
  await page.locator('.owned .warp-btn').first().click()
  await expect(page.getByTestId('building-panel')).toHaveAttribute('data-building', '4471')
}

/** Zoom the camera in around an on-map element (wheel zooms about the cursor), then centre it. */
export async function zoomOnMap(page: Page, testId: string, steps: number, centre = { x: 720, y: 520 }) {
  const box = (await page.getByTestId(testId).first().boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, -300)
    await page.waitForTimeout(60)
  }
  const b2 = (await page.getByTestId(testId).first().boundingBox())!
  await page.mouse.move(b2.x + b2.width / 2, b2.y + b2.height / 2)
  await page.mouse.down()
  await page.mouse.move(centre.x, centre.y, { steps: 8 })
  await page.mouse.up()
  await page.waitForTimeout(600)
}

export function num(text: string | null): number {
  return Number((text ?? '').replace(/[^0-9]/g, ''))
}

/** Build a small valid RGB PNG in memory (gradient) for upload tests. */
export function makePng(w = 96, h = 48): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc = (buf: Buffer) => {
    let c = 0xffffffff
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const c = Buffer.alloc(4)
    c.writeUInt32BE(crc(td))
    return Buffer.concat([len, td, c])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const raw = Buffer.alloc((w * 3 + 1) * h)
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3
      raw[o] = Math.round((x / w) * 255)
      raw[o + 1] = 80 + Math.round((y / h) * 150)
      raw[o + 2] = 220
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

export interface Pixels {
  width: number
  height: number
  /** Bytes per pixel: 3 (RGB) or 4 (RGBA). */
  channels: number
  data: Buffer
}

/** Decode a screenshot PNG (8-bit RGB / RGBA, non-interlaced: what Playwright writes) to raw pixels. */
export function decodePng(png: Buffer): Pixels {
  let width = 0
  let height = 0
  let channels = 0
  const idat: Buffer[] = []
  for (let off = 8; off < png.length; ) {
    const len = png.readUInt32BE(off)
    const type = png.toString('ascii', off + 4, off + 8)
    const body = png.subarray(off + 8, off + 8 + len)
    if (type === 'IHDR') {
      width = body.readUInt32BE(0)
      height = body.readUInt32BE(4)
      if (body[8] !== 8 || (body[9] !== 2 && body[9] !== 6) || body[12] !== 0) throw new Error('decodePng: unsupported PNG format')
      channels = body[9] === 6 ? 4 : 3
    } else if (type === 'IDAT') idat.push(body)
    off += 12 + len
  }
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const data = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const src = y * (stride + 1) + 1
    const dst = y * stride
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? data[dst + x - channels] : 0
      const b = y ? data[dst + x - stride] : 0
      const c = x >= channels && y ? data[dst + x - stride - channels] : 0
      let v = raw[src + x]
      if (filter === 1) v += a
      else if (filter === 2) v += b
      else if (filter === 3) v += (a + b) >> 1
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      data[dst + x] = v & 255
    }
  }
  return { width, height, channels, data }
}
