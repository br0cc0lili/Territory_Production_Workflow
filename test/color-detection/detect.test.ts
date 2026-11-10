// Color Detection node logic: input normalisation, per-role decisions,
// LOW / review flags, output shape.
import { describe, expect, it } from 'vitest'
import detect from '../../src/nodes/color-detection/detect.js'
import { BRAND_ASE } from '../helpers/ase'

const { detectTextColors, normalizePalette } = detect
type Px = [number, number, number]
const image = (w: number, h: number, px: (x: number, y: number) => Px) => {
  const data = new Uint8Array(w * h * 4)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = (y * w + x) * 4; const p = px(x, y); data.set([p[0], p[1], p[2], 255], i) }
  return { width: w, height: h, data }
}
const DARK: Px = [20, 20, 30]
const BRIGHT: Px = [235, 235, 235]
// 400 × 400: dark upper half, bright lower half
const split = image(400, 400, (_x, y) => (y < 200 ? DARK : BRIGHT))
const palette = {
  swatches: [
    { id: 'White', name: 'White', model: 'RGB', values: [1, 1, 1] },
    { id: 'Black', name: 'Black', rgb: [0, 0, 0] },
    { id: 'Red', name: 'Red', hex: '#bb0a30' },
  ],
}
const layout = {
  roles: [
    { role: 'headline', fontSizePt: 87, lines: [[40, 20, 80, 380], [90, 20, 130, 300]] },
    { role: 'subline', fontSizePt: 37, lines: [[300, 20, 330, 360]] },
  ],
}

describe('detectTextColors', () => {
  it('decides each role on its own lines: headline over dark → White, subline over bright → Black', () => {
    const r = detectTextColors({ image: split, layout, palette, options: {} })
    expect(r.status).toBe('ok')
    expect(r.roles.map((x: any) => [x.role, x.color.name, x.readability])).toEqual([['headline', 'White', 'OK'], ['subline', 'Black', 'OK']])
    const h = r.roles[0]
    expect(h.threshold).toBe(3)
    expect(h.contrast.weakestZone).toBeLessThanOrEqual(h.contrast.overallP10)
    expect(h.lines).toBe(2)
    expect(h.zones).toBeGreaterThan(2)
    expect(h.ranking.map((x: any) => x.name)).toEqual(['White', 'Red', 'Black'])
    expect(r.summary).toMatch(/^headline White [\d.]+:1 \| subline Black [\d.]+:1$/)
    expect(JSON.parse(JSON.stringify(r))).toEqual(r) // JSON-safe output
  })

  it('maps page coordinates (pt + pageBounds) onto a smaller render exactly like pixel boxes', () => {
    const half = image(200, 200, (_x, y) => (y < 100 ? DARK : BRIGHT))
    const pt = detectTextColors({ image: half, layout: { coordinateSpace: { unit: 'pt', pageBounds: [0, 0, 400, 400] }, roles: layout.roles }, palette })
    const px = detectTextColors({ image: split, layout, palette })
    expect(pt.roles.map((x: any) => [x.color.name, x.contrast.weakestZone])).toEqual(px.roles.map((x: any) => [x.color.name, x.contrast.weakestZone]))
  })

  it('a bright patch under part of the headline → best approved colour still applied, LOW, review', () => {
    // dark background, but the right 20 % of the headline line is bright
    const img = image(400, 400, (x, y) => (y >= 40 && y < 80 && x >= 300 ? [238, 238, 238] : DARK))
    const r = detectTextColors({ image: img, layout: { roles: [layout.roles[0]] }, palette })
    const h = r.roles[0]
    expect(h.color.name).toBe('Red')
    expect(h.readability).toBe('LOW')
    expect(h.readable).toBe(false)
    expect(h.contrast.weakestZone).toBeLessThan(3)
    expect(h.weakest.line).toBe(0)
    expect(r.status).toBe('review')
    expect(h.warning).toBe(`low text contrast — headline Red reaches ${h.contrast.weakestZone}:1 in its weakest part (needs 3:1); best of the selected colours`)
    expect(r.warnings).toContain(h.warning)
    expect(r.summary).toMatch(/headline Red [\d.]+:1 LOW \(< 3:1\)/)
  })

  it('uses only the approved (selected) colours', () => {
    const r = detectTextColors({ image: split, layout, palette: { ...palette, selectedIds: ['Red'] } })
    expect(r.roles.every((x: any) => x.color.name === 'Red')).toBe(true)
    expect(r.candidates).toBe(1)
  })

  it('small text (no fontSizePt or < 18 pt) needs 4.5:1; thresholds are configurable', () => {
    const r = detectTextColors({ image: split, layout: { roles: [{ role: 'legal', lines: [[300, 20, 310, 200]] }, { role: 'small', fontSizePt: 10, lines: [[320, 20, 330, 200]] }] }, palette })
    expect(r.roles.map((x: any) => x.threshold)).toEqual([4.5, 4.5])
    expect(r.warnings).toContain('legal: no fontSizePt — judged as normal-size text')
    const strict = detectTextColors({ image: split, layout, palette, options: { largeTextThreshold: '7', largeTextFromPt: 30 } })
    expect(strict.roles.map((x: any) => x.threshold)).toEqual([7, 7])
    expect(strict.scoring.thresholds).toEqual({ large: 7, normal: 4.5, largeFromPt: 30 })
  })

  it('falls back to the whole frame (with a warning) when no glyph line boxes are sent', () => {
    const r = detectTextColors({ image: split, layout: { roles: [{ role: 'headline', fontSizePt: 60, frame: [40, 20, 130, 380] }] }, palette })
    expect(r.roles[0].source).toBe('frame')
    expect(r.warnings[0]).toMatch(/whole text frame/)
  })

  it('text area outside the render → NO_DATA, no colour, review', () => {
    const r = detectTextColors({ image: split, layout: { roles: [{ role: 'headline', fontSizePt: 60, lines: [[500, 500, 540, 900]] }] }, palette })
    expect(r.roles[0].readability).toBe('NO_DATA')
    expect(r.roles[0].color).toBeNull()
    expect(r.status).toBe('review')
  })

  it('rejects malformed inputs with a message naming the field', () => {
    const bad = (layoutIn: any, paletteIn: any = palette) => () => detectTextColors({ image: split, layout: layoutIn, palette: paletteIn })
    expect(bad({ roles: [] })).toThrow(/textLayout.roles/)
    expect(bad({ roles: [layout.roles[0], layout.roles[0]] })).toThrow(/appears twice/)
    expect(bad({ roles: [{ role: 'headline', lines: [[10, 10, 5, 50]] }] })).toThrow(/textLayout.roles\[0\].lines\[0\]/)
    expect(bad({ roles: [{ role: 'headline' }] })).toThrow(/needs "lines"/)
    expect(bad({ coordinateSpace: { unit: 'mm' }, roles: layout.roles })).toThrow(/"px" or "pt"/)
    expect(bad({ coordinateSpace: { unit: 'pt' }, roles: layout.roles })).toThrow(/pageBounds/)
    expect(bad(layout, { swatches: [{ name: 'X', model: 'RGB', values: [255, 0, 0] }] })).toThrow(/0–1 .* use "rgb" for 0–255/)
    expect(bad(layout, { ...palette, selectedIds: ['Nope'] })).toThrow(/not in the palette: Nope/)
    expect(bad(layout, { swatches: [] })).toThrow(/palette.swatches/)
    try { bad({ roles: [] })() } catch (e: any) { expect([e.name, e.expose]).toEqual(['NodeInputError', true]) }
  })
})

describe('normalizePalette', () => {
  it('reads an ASE palette and keeps CMYK/LAB values in their own model', () => {
    const c = normalizePalette({ ase: new Uint8Array(BRAND_ASE()), selectedIds: ['Brand/Black', 'Brand/Red'] })
    expect(c.map((s: any) => [s.id, s.model])).toEqual([['Brand/Black', 'CMYK'], ['Brand/Red', 'LAB']])
    expect(c[0].hex).toBe('#000000')
  })
  it('accepts model+values, rgb and hex', () => {
    const c = normalizePalette({ swatches: [{ name: 'A', model: 'CMYK', values: [0, 1, 1, 0] }, { name: 'B', rgb: [1, 2, 3] }, { name: 'C', hex: 'FFFFFF' }] })
    expect(c.map((s: any) => s.hex)).toEqual(['#ff0000', '#010203', '#ffffff'])
    expect(c[1].model).toBe('RGB')
  })
})
