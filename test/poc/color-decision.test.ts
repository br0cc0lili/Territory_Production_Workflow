// Production carrier: dist/color-decision.psjs (Photoshop action V2 node) writes
// the Color Decision ONLY as XMP in our namespace — verified here in a simulated
// sandbox (the same detect.js as the Custom Node), plus the codec on its own.
// Desktop Photoshop 27.10 run (2026-11-11): all 3 configs × PNG/JPEG/PSD/TIFF
// carried the expected decision, PNG/TIFF pixels bit-identical to the input.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'
import { beforeAll, describe, expect, it } from 'vitest'
import raster from '../../src/shared/raster.js'
import detect from '../../src/nodes/color-detection/detect.js'
import { makePng } from '../helpers/mock-assets'
// @ts-ignore — .mjs build script
import { buildAll } from '../../poc/photoshop-action-v2/build.mjs'
// @ts-ignore — .mjs
import { makeConfigPng } from '../../poc/photoshop-action-v2/make-config-png.mjs'
import X from '../../poc/photoshop-action-v2/src/decision-xmp.js'

const POC = join(__dirname, '../../poc/photoshop-action-v2')
const BG = join(POC, 'test-data/marderabwehr_background_1080.png')
const VARIANTS = ['audi-core', 'light-greys', 'mid-greys', 'black-white', 'black-white-print']
const fixture = JSON.parse(readFileSync(join(__dirname, '../fixtures/color-detection/mock-submission.json'), 'utf8'))
const synthConfig = { id: 'synthetic', textLayout: fixture.inputs[1].json, palette: fixture.inputs[2].json, options: {} }

let script: string
let synth: any
beforeAll(async () => {
  await buildAll()
  script = readFileSync(join(POC, 'dist/color-decision.psjs'), 'utf8')
  synth = await raster.decodeImage(await makePng(540, 540, (x, y) => (y * 2 < 540 ? (y * 2 >= 80 && y * 2 < 170 && x * 2 >= 600 ? [238, 238, 238] : [20, 20, 30]) : [235, 235, 235])))
})

const SAMPLE_XMP = '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:description><rdf:Alt><rdf:li xml:lang="x-default">client caption</rdf:li></rdf:Alt></dc:description></rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>'

function runProduction(code: string, image: any, files: Record<string, Uint8Array>, opts: { failSet?: boolean; xmp?: string } = {}) {
  const calls: string[] = []
  let xmp = opts.xmp ?? SAMPLE_XMP
  const doc: any = { id: 3, width: image.width, height: image.height }
  const ps: any = {
    app: {
      activeDocument: doc,
      batchPlay: async (descs: any[]) => descs.map((d) => {
        calls.push(d._obj)
        if (d._obj === 'get' && d._target[0]._property === 'XMPMetadataAsUTF8') return { XMPMetadataAsUTF8: xmp }
        if (d._obj === 'set' && d._target[0]._property === 'XMPMetadataAsUTF8') { if (opts.failSet) throw new Error('set not supported'); xmp = d.to.XMPMetadataAsUTF8; return {} }
        throw new Error('unexpected batchPlay ' + d._obj)
      }),
    },
    core: {},
    imaging: { getPixels: async () => ({ imageData: { width: image.width, height: image.height, components: 4, getData: async () => image.data, dispose() {} } }) },
  }
  const uxp = { host: { name: 'Photoshop', version: '27.10.0' }, storage: { formats: { binary: 1 }, localFileSystem: {} } }
  const fs = { readFileSync: (p: string) => { if (!(p in files)) throw new Error('Route not found'); const v = files[p]; return v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) } }
  const allowed: any = { photoshop: ps, uxp, fs }
  const ctx = vm.createContext({ // no TextEncoder/TextDecoder in Photoshop's script runtime
    require: (m: string) => { if (!(m in allowed)) throw new Error('Module not found: ' + m); return allowed[m] }, console: { log() {}, error() {} }, Promise, Date, JSON, Math, Uint8Array, ArrayBuffer, Float32Array, Array, Object, Error, String, Number, Set, Map, RegExp })
  const finished: Promise<void> = vm.runInContext(`(async () => {\n${code}\n})()`, ctx)
  return { finished, calls, xmp: () => xmp }
}

const withPath = (code: string) => code.split('__ADDITIONAL_CONTENTS_PATH_0__').join('/job/assets/config.png')
const withoutEngine = (d: any) => { const { engine, configId, ...rest } = d; return rest }

describe('decision-xmp codec', () => {
  const decision = { schema: X.SCHEMA, status: 'ok', roles: [{ role: 'headline', swatch: { id: 'g/Ä "x" <y> & z', name: 'Grüner Ton' } }], warnings: [] }
  it('round-trips through an existing packet, keeps other metadata, replaces an earlier decision', () => {
    const once = X.insertIntoXmp(SAMPLE_XMP, decision)
    expect(X.extractFromXmp(once)).toEqual(decision)
    expect(once).toContain('client caption')
    const twice = X.insertIntoXmp(once, { ...decision, status: 'review' })
    expect(twice.match(/ColorDecision>/g)).toHaveLength(2) // one open + one close tag
    expect(X.extractFromXmp(twice).status).toBe('review')
  })
  it('reads the attribute form the XMP toolkit writes into PNG/JPEG, and an empty packet', () => {
    const attr = `<x:xmpmeta><rdf:RDF><rdf:Description rdf:about="" xmlns:foo="${X.NS}" foo:ColorDecision="${X.esc(JSON.stringify(decision))}"/></rdf:RDF></x:xmpmeta>`
    expect(X.extractFromXmp(attr)).toEqual(decision)
    expect(X.extractFromXmp(X.insertIntoXmp('', decision))).toEqual(decision)
    expect(X.extractFromXmp(SAMPLE_XMP)).toBeNull()
  })
  it('finds the packet in raw file bytes and keeps UTF-8 intact', () => {
    const packet = Buffer.from(X.insertIntoXmp(SAMPLE_XMP, decision), 'utf8')
    const file = new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]), packet, Buffer.alloc(64, 7)]))
    expect(X.extractFromXmp(X.xmpTextFromBytes(file))).toEqual(decision)
  })
})

describe('production script (Photoshop action V2, simulated sandbox)', () => {
  it('writes only the decision into XMP — no layers, fills, canvas changes or other files', async () => {
    const png = new Uint8Array(await makeConfigPng(JSON.stringify(synthConfig)))
    const run = runProduction(withPath(script), synth, { '/job/assets/config.png': png })
    await run.finished
    expect(new Set(run.calls)).toEqual(new Set(['get', 'set']))
    const d = X.extractFromXmp(run.xmp())
    const expected = X.compactDecision(detect.detectTextColors({ image: synth, layout: synthConfig.textLayout, palette: synthConfig.palette, options: {} }), synth)
    expect(withoutEngine(d)).toEqual(JSON.parse(JSON.stringify(expected)))
    expect(d.configId).toBe('synthetic')
    expect(d.engine).toMatchObject({ pixels: 'imaging.getPixels', config: 'assets (png text chunk)', host: 'Photoshop 27.10.0' })
    expect(run.xmp()).toContain('client caption') // the image's own metadata stays
  })
  it('detection error → image passes through with status "error" (InDesign refuses it)', async () => {
    const bad = new Uint8Array(await makeConfigPng(JSON.stringify({ ...synthConfig, textLayout: { roles: [] } })))
    const run = runProduction(withPath(script), synth, { '/job/assets/config.png': bad })
    await run.finished
    expect(X.extractFromXmp(run.xmp())).toMatchObject({ status: 'error', error: '"textLayout.roles" must be a non-empty array', roles: [] })
    const unset = runProduction(script, synth, {})
    await unset.finished
    expect(X.extractFromXmp(unset.xmp()).error).toMatch(/connect the config PNG to the Assets port/)
  })
  it('decision cannot be written → the script throws (node run fails, no image without a decision)', async () => {
    const png = new Uint8Array(await makeConfigPng(JSON.stringify(synthConfig)))
    await expect(runProduction(withPath(script), synth, { '/job/assets/config.png': png }, { failSet: true }).finished).rejects.toThrow('set not supported')
  })
  it.runIf(existsSync(BG))('dynamic config: same script + image, the Assets config alone changes the decision', async () => {
    const img = await raster.decodeImage(readFileSync(BG))
    const got: Record<string, any> = {}
    for (const v of VARIANTS) {
      const png = new Uint8Array(await makeConfigPng(readFileSync(join(POC, `test-data/config.${v}.json`), 'utf8')))
      const run = runProduction(withPath(script), img, { '/job/assets/config.png': png })
      await run.finished
      got[v] = X.extractFromXmp(run.xmp())
      expect(withoutEngine(got[v])).toEqual(JSON.parse(readFileSync(join(POC, `test-data/expected-decision.${v}.json`), 'utf8')))
      expect(got[v].configId).toBe(`marderabwehr/${v}`)
    }
    const pick = (v: string) => got[v].roles.map((r: any) => `${r.role} ${r.swatch.name} ${r.readability}`)
    expect(pick('audi-core')).toEqual(['headline White RGB OK', 'subline White RGB OK'])
    expect(pick('light-greys')).toEqual(['headline Grey 10 RGB OK', 'subline Grey 10 RGB OK'])
    expect(pick('mid-greys')).toEqual(['headline Grey 5 RGB LOW', 'subline Grey 5 RGB LOW'])
    expect(got['mid-greys'].status).toBe('review')
    expect(pick('black-white')).toEqual(['headline White RGB OK', 'subline White RGB OK'])
    expect(got['black-white-print'].roles[0].swatch).toMatchObject({ name: 'White CMYK', model: 'CMYK', values: [0, 0, 0, 0] })
  })
  it('Audi Black + White (original ASE definitions): headline and subline choose independently', async () => {
    const cfg = JSON.parse(readFileSync(join(POC, 'test-data/config.black-white.json'), 'utf8'))
    expect(cfg.palette.swatches.map((s: any) => [s.id, s.model, s.values])).toEqual([
      ['Audi_Colour_Library_digital/Audi Black RGB', 'RGB', [0, 0, 0]], ['Audi_Colour_Library_digital/White RGB', 'RGB', [1, 1, 1]]])
    const print = JSON.parse(readFileSync(join(POC, 'test-data/config.black-white-print.json'), 'utf8'))
    expect(print.palette.swatches.map((s: any) => [s.name, s.model, s.values.map((v: number) => +v.toFixed(3))])).toEqual([['Audi Black CMYK', 'CMYK', [0.4, 0, 0, 1]], ['White CMYK', 'CMYK', [0, 0, 0, 0]]])
    // dark behind the headline, light behind the subline (same 1080 pt page as the config)
    const img = await raster.decodeImage(await makePng(540, 540, (x, y) => (y * 2 < 500 ? [25, 25, 30] : [235, 235, 230])))
    const png = new Uint8Array(await makeConfigPng(JSON.stringify(cfg)))
    const run = runProduction(withPath(script), img, { '/job/assets/config.png': png })
    await run.finished
    const d = X.extractFromXmp(run.xmp())
    expect(d.roles.map((r: any) => [r.role, r.swatch.name, r.readability])).toEqual([['headline', 'White RGB', 'OK'], ['subline', 'Audi Black RGB', 'OK']])
  })
})
