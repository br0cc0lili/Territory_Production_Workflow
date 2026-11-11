// InDesign side of the hand-over (poc/indesign-apply): reads the decision from
// the placed image and applies it like the plugin does. DOM test doubles here;
// desktop InDesign 21.6 run (2026-11-11): TIFF / PNG / JPEG decisions read via
// linkXmp and applied, "review" flagged, image without decision skipped.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import core from '../../poc/indesign-apply/src/apply-core.js'
import cap from '../../poc/indesign-apply/src/capability.js'
import X from '../../poc/photoshop-action-v2/src/decision-xmp.js'

const POC = join(__dirname, '../../poc/photoshop-action-v2/test-data')
const decisionOf = (v: string) => ({ ...JSON.parse(readFileSync(join(POC, `expected-decision.${v}.json`), 'utf8')), configId: `marderabwehr/${v}` })

const idm = { ColorModel: { PROCESS: 'process' }, ColorSpace: { RGB: 'rgb', CMYK: 'cmyk', LAB: 'lab' } }
class TextFrame { constructor(public name: string, public parentStory: any) {} labels: Record<string, string> = {}; insertLabel(k: string, v: string) { this.labels[k] = v } }
class Rectangle { constructor(public name: string, public allGraphics: any[]) {} }
function fakeDoc(existing: string[] = []) {
  const colors: any[] = existing.map((name) => ({ name, isValid: true, preexisting: true }))
  return {
    colors: {
      itemByName: (n: string) => colors.find((c) => c.name === n) || { isValid: false },
      add: (p: any) => { const c = { ...p, isValid: true }; colors.push(c); return c },
    },
    _colors: colors,
  }
}
function fakePage(paragraphs: string[], xmpOfImage: string | null, fileText?: string) {
  const paras = paragraphs.map((contents) => ({ contents, fillColor: { name: 'Black' } as any }))
  const story = { paragraphs: { length: paras.length, item: (i: number) => paras[i] } }
  const frame = new TextFrame('<<Headline>>', story)
  const link = { filePath: '/wf/bg.png', linkXmp: { getProperty: (ns: string, p: string) => (xmpOfImage && ns === X.NS && p === 'tcd:ColorDecision' ? xmpOfImage : '') } }
  const rect = new Rectangle('<<MainImage>>', [{ itemLink: link }])
  return { page: { allPageItems: [rect, frame] }, frame, paras, fileText }
}

describe('apply-core (plugin conventions)', () => {
  it('ok decision from the placed image (linkXmp): headline = 1st, subline = 2nd non-empty paragraph, colours created once, label v2', async () => {
    const doc = fakeDoc()
    const p = fakePage(['', 'Marderabwehr', 'Jetzt schützen'], JSON.stringify(decisionOf('light-greys')))
    const r = await core.applyToPage(doc, p.page, idm, {}, null)
    expect(r).toMatchObject({ status: 'applied', source: 'linkXmp', configId: 'marderabwehr/light-greys', warnings: [] })
    expect(r.applied.map((a: any) => [a.role, a.paragraph, a.name])).toEqual([['headline', 1, 'Grey 10 RGB'], ['subline', 2, 'Grey 10 RGB']])
    expect(p.paras[0].fillColor.name).toBe('Black')
    expect(p.paras[1].fillColor).toMatchObject({ name: 'Grey 10 RGB', space: 'rgb', colorValue: [229, 229, 229], model: 'process' })
    expect(doc._colors).toHaveLength(1)
    expect(JSON.parse(p.frame.labels['posterBatch.textColor'])).toEqual({ v: 2,
      headline: { swatch: 'Audi_Colour_Library_digital/Grey 10 RGB', name: 'Grey 10 RGB', score: 6.2, threshold: 3, readable: true },
      subline: { swatch: 'Audi_Colour_Library_digital/Grey 10 RGB', name: 'Grey 10 RGB', score: 5.3, threshold: 3, readable: true } })
  })
  it('review: best approved colour is still applied and the low contrast reported (as the plugin does)', async () => {
    const p = fakePage(['H', 'S'], JSON.stringify(decisionOf('mid-greys')))
    const r = await core.applyToPage(fakeDoc(), p.page, idm, {}, null)
    expect(r.status).toBe('review')
    expect(p.paras[0].fillColor.name).toBe('Grey 5 RGB')
    expect(r.warnings.filter((w: any) => String(w).startsWith('low text contrast'))).toHaveLength(2)
  })
  it('reuses a template colour of the same name; hex-only swatches become RGB', async () => {
    const doc = fakeDoc(['White RGB'])
    const d = decisionOf('audi-core')
    d.roles[1].swatch = { id: 'x/Red', name: 'Audi Progressive Red RGB', rgb: [245, 5, 55], hex: '#f50537' }
    const p = fakePage(['H', 'S'], JSON.stringify(d))
    await core.applyToPage(doc, p.page, idm, {}, null)
    expect(p.paras[0].fillColor.preexisting).toBe(true)
    expect(p.paras[1].fillColor).toMatchObject({ space: 'rgb', colorValue: [245, 5, 55] })
  })
  it('fail closed: error status, no decision, wrong config → nothing applied, template colours stay', async () => {
    const err = fakePage(['H', 'S'], JSON.stringify(X.errorDecision('bad config')))
    expect(await core.applyToPage(fakeDoc(), err.page, idm, {}, null)).toMatchObject({ status: 'skipped', reason: 'Color Detection failed: bad config' })
    const none = fakePage(['H', 'S'], null)
    expect(await core.applyToPage(fakeDoc(), none.page, idm, {}, null)).toMatchObject({ status: 'skipped', reason: 'no Color Decision found', source: 'no decision in the placed image' })
    const wrong = fakePage(['H', 'S'], JSON.stringify(decisionOf('light-greys')))
    expect(await core.applyToPage(fakeDoc(), wrong.page, idm, { expectConfigId: 'marderabwehr/audi-core' }, null)).toMatchObject({ status: 'skipped' })
    for (const p of [err, none, wrong]) expect(p.paras.map((x) => x.fillColor.name)).toEqual(['Black', 'Black'])
  })
  it('falls back to the image file bytes when the link XMP is not readable', async () => {
    const p = fakePage(['H', 'S'], null)
    const fileText = X.insertIntoXmp('', decisionOf('audi-core'))
    const r = await core.applyToPage(fakeDoc(), p.page, idm, {}, null, async (path: string) => (path === '/wf/bg.png' ? fileText : ''))
    expect(r).toMatchObject({ status: 'applied', source: 'link file' })
  })
  it('a role without a paragraph is reported, the other role still applied', async () => {
    const p = fakePage(['Only a headline'], JSON.stringify(decisionOf('audi-core')))
    const r = await core.applyToPage(fakeDoc(), p.page, idm, {}, null)
    expect(r.applied.map((a: any) => a.role)).toEqual(['headline'])
    expect(r.warnings).toEqual(['role subline: frame has no paragraph #2 — not applied'])
  })
})

describe('InDesign API capability', () => {
  it('resolves asset paths only inside the working folder', () => {
    expect(cap.resolveIn('/tmp/wf/', 'in/template.indd')).toBe('/tmp/wf/in/template.indd')
    expect(cap.resolveIn('C:\\jobs\\wf', 'in/a.png')).toBe('C:\\jobs\\wf\\in\\a.png')
    for (const bad of ['../x.indd', '/etc/x', 'C:\\x', '']) expect(() => cap.resolveIn('/tmp/wf', bad)).toThrow(/invalid relative path/)
  })
})
