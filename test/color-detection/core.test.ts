// The reused core (src/core/textcolor.js + palette.js) — the plugin's own
// regression cases (tools/tests/textcolor.test.js), run against the copies.
import { describe, expect, it } from 'vitest'
import tc from '../../src/core/textcolor.js'
import pal from '../../src/core/palette.js'
import { BRAND_ASE } from '../helpers/ase'

const sw = pal.parseASE(BRAND_ASE())
const bg = (rgb: number[], w = 40, h = 20) => ({ width: w, height: h, data: Uint8Array.from({ length: w * h * 4 }, (_, i) => (i % 4 === 3 ? 255 : rgb[i % 4])) })
// a text line: bright metal, dark cable from x = darkFrom on
const line = (w: number, h: number, darkFrom: number) => ({
  width: w, height: h,
  data: Uint8Array.from({ length: w * h * 4 }, (_, i) => { if (i % 4 === 3) return 255; const x = Math.floor(i / 4) % w; return x >= darkFrom ? 12 : 238 }),
})

describe('palette (ASE)', () => {
  it('parses 5 colours, keeps group names, respects group end', () => {
    expect(sw.map((s: any) => s.name)).toEqual(['White', 'Black', 'Red', 'Grey', 'Loose'])
    expect(sw[0].group).toBe('Brand')
    expect(sw[4].group).toBe('')
    expect(sw[0].id).toBe('Brand/White')
  })
  it('converts RGB / CMYK / Gray / LAB to sRGB', () => {
    expect([sw[0].hex, sw[1].hex, sw[3].hex, sw[4].hex]).toEqual(['#ffffff', '#000000', '#808080', '#0000ff'])
    expect(sw[2].rgb[0]).toBeGreaterThan(180)
    expect(sw[2].rgb[1]).toBeLessThan(80)
  })
  it('keeps CMYK as CMYK for InDesign; only selected swatches are candidates', () => {
    expect(pal.inDesignColor(sw[1])).toEqual({ space: 'CMYK', values: [0, 0, 0, 100] })
    expect(pal.selectedSwatches({ swatches: sw }, [sw[0].id, sw[1].id])).toHaveLength(2)
    expect(pal.selectedSwatches({ swatches: sw }, [])).toHaveLength(0)
  })
  it('rejects a non-ASE file', () => {
    expect(() => pal.parseASE(Buffer.from('not an ase file'))).toThrow(/not an Adobe Swatch Exchange/)
  })
})

describe('weakest-zone scoring (textcolor)', () => {
  it('WCAG white/black contrast = 21', () => {
    expect(tc.contrastRatio(tc.relativeLuminance(255, 255, 255), tc.relativeLuminance(0, 0, 0))).toBeCloseTo(21, 9)
  })
  it('splits a 400 × 40 line into 5 zones', () => {
    expect(tc.sampleZones(line(400, 40, 368), [{ x: 0, y: 0, width: 400, height: 40 }])).toHaveLength(5)
  })
  it('Marderabwehr case: whole-box P10 picks Black, weakest-zone scoring picks Red', () => {
    const marder = line(400, 40, 368)
    const box = { x: 0, y: 0, width: 400, height: 40 }
    const red = sw.find((s: any) => s.name === 'Red')
    const cand = [sw[0], sw[1], red]
    expect(tc.chooseTextColor(tc.sampleLuminances(marder, box), cand)!.swatch.name).toBe('Black')
    const neu = tc.chooseTextColorByZones(tc.sampleZones(marder, [box]), cand, tc.readabilityThreshold(87))
    const black = neu.ranking.find((x: any) => x.swatch.name === 'Black')
    expect(neu.swatch.name).toBe('Red')
    expect(black.weakest.zone).toBe(4)
    expect(black.score).toBeLessThan(1.5)
    expect(neu.score).toBeLessThanOrEqual(neu.overall)
  })
  it('thresholds: ≥ 18 pt → 3:1, smaller → 4.5:1; best returned even when not readable', () => {
    expect([tc.readabilityThreshold(87), tc.readabilityThreshold(18), tc.readabilityThreshold(14)]).toEqual([3, 3, 4.5])
    const bright = tc.sampleZones(bg([238, 238, 238], 200, 20), [{ x: 0, y: 0, width: 200, height: 20 }])
    const red = sw.find((s: any) => s.name === 'Red')
    const g = tc.chooseTextColorByZones(bright, [sw[0], red], 4.5)
    expect(g.swatch.name).toBe('Red')
    expect(g.readable).toBe(false)
    expect(g.score).toBeLessThan(4.5)
  })
  it('no lines / no candidates → null', () => {
    const bright = tc.sampleZones(bg([238, 238, 238], 200, 20), [{ x: 0, y: 0, width: 200, height: 20 }])
    expect(tc.chooseTextColorByZones([], [sw[0]], 3)).toBeNull()
    expect(tc.chooseTextColorByZones(bright, [], 3)).toBeNull()
  })
})
