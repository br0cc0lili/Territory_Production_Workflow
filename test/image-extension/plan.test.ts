// Image Extension planning + compositing (pure, no Firefly).
import { describe, expect, it } from 'vitest'
import planMod from '../../src/nodes/image-extension/plan.js'
import composeMod from '../../src/nodes/image-extension/compose.js'
import core from '../../src/core/extension-plan.js'
import raster from '../../src/shared/raster.js'

const { planJob, normalizeTargets, readOptions } = planMod
const SOURCE = { key: 'abc123', width: 300, height: 200, format: 'png' }
const T = (id: string, cw: number, ch: number, x: number, y: number, w = 300, h = 200) => ({ id, canvas: { width: cw, height: ch }, placement: { x, y, width: w, height: h } })
const MOCK = [T('landscape', 300, 200, 0, 0), T('square', 300, 260, 0, 0), T('tall', 240, 240, -30, 20), T('poster', 300, 400, 0, 0)]
const plan = (targets: any[], params: object = {}) => planJob({ source: SOURCE, targets: normalizeTargets({ targets }), options: readOptions(params) })

describe('planJob', () => {
  it('per target: covered → not_required, gaps → planned, over the 50 % limit → needs_review', () => {
    const r = plan(MOCK)
    expect(r.targets.map((t: any) => [t.id, t.status])).toEqual([['landscape', 'not_required'], ['square', 'planned'], ['tall', 'planned'], ['poster', 'needs_review']])
    expect(r.targets[1].missing).toEqual({ top: 0, right: 0, bottom: 60, left: 0 })
    expect(r.targets[2].missing).toEqual({ top: 20, right: 0, bottom: 20, left: 0 }) // sides overhang: cropped, not missing
    expect(r.targets[3].reasons[0]).toMatch(/exceeds automatic generation limit \(100% > 50%\)/)
  })

  it('shared (default): one master for every target it can serve — per-side maximum of their gaps', () => {
    const r = plan(MOCK)
    expect(r.units).toHaveLength(1)
    const m = r.units[0].master
    expect(r.units[0].targetIds).toEqual(['square', 'tall'])
    expect(m.kind).toBe('master')
    expect(m.id).toMatch(/^EXT_[0-9a-f]{8}$/)
    expect(m.expansionPixels).toEqual({ top: 20, right: 0, bottom: 60, left: 0 })
    expect(m.working.size).toEqual({ width: 300, height: 280 })
    // JSON: the plugin's ceil(0 - 1e-9) gives -0 for unextended sides; it serialises as 0 in the Firefly request
    expect(JSON.parse(JSON.stringify(m.working.inset))).toEqual({ top: 20, right: 0, bottom: 60, left: 0 })
    expect(r.targets.filter((t: any) => t.masterId === m.id).map((t: any) => t.id)).toEqual(['square', 'tall'])
  })

  it('independent: one generation per target', () => {
    const r = plan(MOCK, { batchMode: 'independent' })
    expect(r.units.map((u: any) => u.targetIds)).toEqual([['square'], ['tall']])
    expect(r.units[0].master.working.size).toEqual({ width: 300, height: 260 })
  })

  it('allowLarge: the over-limit target joins the shared master', () => {
    const r = plan(MOCK, { allowLarge: true })
    expect(r.targets[3].status).toBe('planned')
    expect(r.targets[3].reasons[0]).toMatch(/generated anyway \(allowLarge\)/)
    expect(r.units).toHaveLength(1)
    expect(r.units[0].master.expansionPixels.bottom).toBe(200)
  })

  it('splits masters only when sharing is impossible (combined extension over the limit)', () => {
    const r = plan([T('bottom', 300, 290, 0, 0), T('top', 300, 290, 0, 90)]) // 90 px bottom vs 90 px top: 45 % each, 90 % combined
    expect(r.units.map((u: any) => u.targetIds)).toEqual([['bottom'], ['top']])
  })

  it('upscaled placement: Firefly working resolution too low → needs_review', () => {
    const r = plan([T('zoomed', 900, 700, 0, 0, 900, 600)]) // source shown at 3× → 0.33 px per output px
    expect(r.targets[0].status).toBe('needs_review')
    expect(r.targets[0].reasons.join()).toMatch(/enough resolution/)
  })

  it('gaps within the tolerance are not sent to Firefly; no overlap → failed', () => {
    expect(plan([T('hairline', 300, 202, 0, 1)]).targets[0].status).toBe('not_required')
    expect(plan([T('hairline', 300, 202, 0, 1)], { coverageTolerancePx: 0 }).targets[0].status).toBe('planned')
    expect(plan([T('off', 300, 200, 400, 0)]).targets[0]).toMatchObject({ status: 'failed', reasons: ["the placed image doesn't overlap the canvas"] })
  })

  it('validates inputs and parameters', () => {
    expect(() => normalizeTargets({ targets: [] })).toThrow(/layout.targets/)
    expect(() => normalizeTargets({ targets: [T('a b', 1, 1, 0, 0)] })).toThrow(/targets\[0\].id/)
    expect(() => normalizeTargets({ targets: [T('a', 1, 1, 0, 0), T('a', 1, 1, 0, 0)] })).toThrow(/appears twice/)
    expect(() => normalizeTargets({ targets: [T('a', 9000, 1, 0, 0)] })).toThrow(/"width" must be an integer between 1 and 8000/)
    expect(() => normalizeTargets({ targets: [{ id: 'a', canvas: { width: 1, height: 1 } }] })).toThrow(/placement/)
    expect(() => readOptions({ batchMode: 'all' })).toThrow(/batchMode/)
    expect(readOptions({})).toEqual({ batchMode: 'shared', maxExtensionRatio: 0.5, allowLarge: false, coverageTolerancePx: 2 })
  })
})

describe('composeTarget', () => {
  const planner = core.createPlanner()
  const src = () => {
    const img = raster.blankImage(300, 200, 0x000000ff)
    img.scan((x: number, y: number, i: number) => { img.bitmap.data.set([x % 256, y % 256, (x * 3 + y * 7) % 256, 255], i) })
    return img
  }
  it('1:1 placement: original pixels are bit-identical, extension fills the rest', () => {
    const r = plan([T('square', 300, 260, 0, 0)])
    const unit = { working: r.units[0].master.working, image: raster.blankImage(300, 280, 0x00c800ff) }
    const c = composeMod.composeTarget({ planner, target: r.targets[0], sourceImage: src(), unit })
    expect(c.originalVerified).toBe(true)
    expect(c.originalRegion).toEqual({ x: 0, y: 0, width: 300, height: 200 })
    expect(c.edgeFilledPx).toBe(0)
    expect([c.image.bitmap.width, c.image.bitmap.height]).toEqual([300, 260])
    const px = (x: number, y: number) => Array.from(c.image.bitmap.data.subarray((y * 300 + x) * 4, (y * 300 + x) * 4 + 4))
    expect(px(123, 45)).toEqual([123, 45, (123 * 3 + 45 * 7) % 256, 255])
    expect(px(150, 230)).toEqual([0, 200, 0, 255])
  })
  it('placement beyond the canvas is cropped; a gap within tolerance is edge-filled', () => {
    const r = plan([T('crop', 240, 201, -30, 0)])
    expect(r.targets[0].status).toBe('not_required')
    const c = composeMod.composeTarget({ planner, target: r.targets[0], sourceImage: src(), unit: null })
    expect(c.originalRegion).toEqual({ x: 0, y: 0, width: 240, height: 200 })
    expect(c.edgeFilledPx).toBe(240)
    const d = c.image.bitmap.data
    expect(Array.from(d.subarray(0, 4))).toEqual([30, 0, 90, 255]) // canvas x 0 = source x 30
    expect(Array.from(d.subarray((200 * 240) * 4, (200 * 240) * 4 + 4))).toEqual(Array.from(d.subarray((199 * 240) * 4, (199 * 240) * 4 + 4)))
  })
})
