// "Photoshop action V2" node probe in the simulated execute-actions sandbox.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'
import { beforeAll, describe, expect, it } from 'vitest'
import raster from '../../src/shared/raster.js'
// @ts-ignore
import { buildAll } from '../../poc/photoshop-action-v2/build.mjs'
// @ts-ignore
import { makeConfigPng } from '../../poc/photoshop-action-v2/make-config-png.mjs'
import payload from '../../poc/photoshop-action-v2/src/payload.js'

const POC = join(__dirname, '../../poc/photoshop-action-v2')
let probe: string, img: any, configPng: Buffer, expected: any

beforeAll(async () => {
  await buildAll()
  probe = readFileSync(join(POC, 'dist/node-probe.psjs'), 'utf8')
  img = await raster.decodeImage(readFileSync(join(POC, 'test-data/marderabwehr_background_1080.png')))
  configPng = await makeConfigPng(readFileSync(join(POC, 'test-data/config.marderabwehr.json'), 'utf8'))
  expected = JSON.parse(readFileSync(join(POC, 'test-data/expected-marderabwehr.json'), 'utf8'))
})

function runProbe(script: string, files: Record<string, Uint8Array | string>, opts: { imaging?: boolean } = {}) {
  const calls: any[] = []
  const written: Record<string, string> = {}
  const doc: any = { id: 1, name: 'bg.png', width: img.width, height: img.height, mode: 'RGBColorMode', bitsPerChannel: 'bitDepth8', activeLayers: [{ id: 9 }],
    createTextLayer: async (o: any) => { calls.push(['text', o.contents]) } }
  const ps: any = { app: { activeDocument: doc, version: '27.10.0', batchPlay: async (d: any[]) => { calls.push(...d.map((x) => [x._obj, x])); return [] } }, core: {} }
  if (opts.imaging !== false) ps.imaging = {
    getPixels: async () => ({ imageData: { width: img.width, height: img.height, components: 4, getData: async () => img.data, dispose() {} } }),
    createImageDataFromBuffer: async (data: Uint8Array, o: any) => ({ ...o, data, dispose() {} }),
    putPixels: async (o: any) => { calls.push(['putPixels', o]) },
  }
  const uxp = { storage: { formats: { binary: 1 }, localFileSystem: { getTemporaryFolder: async () => { throw new Error('temp folder not allowed') } } } }
  const fs = {
    readFileSync: (p: string) => { if (!(p in files)) throw new Error('Route not found'); const v = files[p]; return typeof v === 'string' ? v : v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) },
    writeFileSync: (p: string, d: string) => { if (!p.startsWith('plugin-temp:/')) throw new Error('Route not found'); written[p] = d },
  }
  const process = { version: 'uxp-9.4.1-0' }
  const allowed: any = { photoshop: ps, uxp, fs, process }
  const ctx = vm.createContext({ // no TextEncoder/TextDecoder: Photoshop's script runtime has none
    require: (m: string) => { if (!(m in allowed)) throw new Error('Module not found: ' + m); return allowed[m] }, console: { log() {}, error() {} }, Promise, Date, JSON, Math, Uint8Array, ArrayBuffer, Float32Array, Array, Object, Error, String, Number, Set, Map })
  vm.runInContext(`(async () => {\n${script}\n})()`, ctx) // top-level await → async wrapper (Node vm has no TLA)
  const done = () => new Promise<any>((r) => { const t = () => (written['plugin-temp:/color-decision.json'] ? r(JSON.parse(written['plugin-temp:/color-decision.json'])) : setTimeout(t, 5)); t() })
  return { done, calls }
}

describe('Photoshop action V2 node probe (simulated sandbox)', () => {
  it('Assets → __ADDITIONAL_CONTENTS_PATH_0__ = config PNG: finds the config in the iTXt chunk, same decision as the Custom Node, all carriers attempted', async () => {
    const script = probe.split('__ADDITIONAL_CONTENTS_PATH_0__').join('/job/assets/config.png')
    const { done, calls } = runProbe(script, { '/job/assets/config.png': new Uint8Array(configPng) })
    const r = await done()
    expect(r.ok).toBe(true)
    expect(r.configSource).toBe('additional[0] (png text chunk)')
    expect(r.placeholders).toEqual([expect.objectContaining({ key: 'additional[0]', kind: 'png', config: true, pngText: ['territory-color-detection'] })])
    expect(r.decision).toEqual(expected)
    expect(r.pixels.used).toBe('imaging.getPixels')
    expect(r.pixels.raw).toMatch(/^failed: temp folder not allowed/)
    const caption = calls.find((c) => c[0] === 'set' && c[1].to && c[1].to._obj === 'fileInfo')[1].to.caption
    expect(caption.startsWith('TCD1:')).toBe(true)
    expect(JSON.parse(caption.slice(5)).roles.map((x: any) => [x.role, x.color.name, x.readability])).toEqual([['headline', 'White RGB', 'OK'], ['subline', 'White RGB', 'OK']])
    expect(calls.some((c) => c[0] === 'text')).toBe(true)
    const put = calls.find((c) => c[0] === 'putPixels')[1]
    const strip = put.imageData
    const decoded = JSON.parse(payload.decodePixelPayload({ width: strip.width, height: strip.height, data: strip.data })!)
    expect(decoded.decision).toEqual(expected)
    expect(r.outputs).toMatchObject({ pluginTempJson: 'written', banner: 'ok', textLayer: 'ok', pixelStrip: expect.stringMatching(/rows$/) })
  })
  it('text chunk stripped by the platform: tries to open the config PNG and read its pixels', async () => {
    const stripped = await (await import('jimp')).Jimp.read(configPng).then((i: any) => i.getBuffer('image/png'))
    const script = probe.split('__ADDITIONAL_CONTENTS_PATH_0__').join('/job/assets/config.png')
    const r = await runProbe(script, { '/job/assets/config.png': new Uint8Array(stripped) }).done()
    expect(r.placeholders[0]).toMatchObject({ kind: 'png', pngTextChunkLost: true })
    expect(r.configPngError).toBeDefined() // the fake sandbox has no getEntryWithUrl/open — real Photoshop decides
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/no config found/)
  })
  it('no placeholder replaced + no imaging: reports the error through every carrier it can', async () => {
    const r = await runProbe(probe, {}, { imaging: false }).done()
    expect(r.ok).toBe(false)
    expect(r.placeholders).toEqual([])
    expect(r.pixels.imaging).toMatch(/not available/)
    expect(r.outputs.pixelStrip).toMatch(/putPixels not available/)
  })
})
