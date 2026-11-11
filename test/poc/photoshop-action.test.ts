// PoC: the bundled Photoshop UXP script, run in a Node vm that mimics the
// execute-actions sandbox — only photoshop / uxp / fs can be required, the
// API replaces __ADDITIONAL_CONTENTS_PATH_0__ in the script text, output is
// whatever the script writes to plugin-temp:/. The result must equal the
// Custom Node's (same detect.js), for both pixel paths.
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'
import { beforeAll, describe, expect, it } from 'vitest'
import detect from '../../src/nodes/color-detection/detect.js'
import raster from '../../src/shared/raster.js'
import { makePng } from '../helpers/mock-assets'
// @ts-ignore — .mjs build script
import { buildAll } from '../../poc/photoshop-action-v2/build.mjs'

const POC = join(__dirname, '../../poc/photoshop-action-v2')
const fixture = JSON.parse(readFileSync(join(__dirname, '../fixtures/color-detection/mock-submission.json'), 'utf8'))
const config = { textLayout: fixture.inputs[1].json, palette: fixture.inputs[2].json, options: {} }

type Img = { width: number; height: number; data: Uint8Array }
function sandbox(script: string, opts: { image: Img; files?: Record<string, string>; imaging?: boolean; components?: 3 | 4 }) {
  const written: Record<string, string> = {}
  const calls: string[] = []
  const { image } = opts
  const rgb = (n: number) => {
    if (n === 4) return image.data
    const out = new Uint8Array(image.width * image.height * 3)
    for (let i = 0; i < image.width * image.height; i++) out.set(image.data.subarray(i * 4, i * 4 + 3), i * 3)
    return out
  }
  const doc = {
    id: 7, name: 'background.png', width: image.width, height: image.height, mode: 'RGBColorMode', bitsPerChannel: 'bitDepth8',
    duplicate: async () => ({ flatten: async () => {}, closeWithoutSaving: async () => { calls.push('closeDuplicate') } }),
  }
  let rawBytes: Uint8Array | null = null
  const photoshop: any = {
    app: {
      activeDocument: doc,
      batchPlay: async (descs: any[]) => { for (const d of descs) { calls.push(d._obj); if (d._obj === 'save') rawBytes = rgb(3) } return [] },
    },
  }
  if (opts.imaging !== false) {
    photoshop.imaging = {
      getPixels: async (o: any) => {
        calls.push(`getPixels:${o.colorProfile}`)
        const n = opts.components ?? 3
        return { imageData: { width: image.width, height: image.height, components: n, getData: async () => rgb(n), dispose: () => calls.push('dispose') } }
      },
    }
  }
  const tempFile = { read: async () => rawBytes!.buffer }
  // batchPlay 'save' (RAW copy) fills rawBytes
  const uxp = { storage: { formats: { binary: 'binary' }, localFileSystem: { getTemporaryFolder: async () => ({ createFile: async () => tempFile }), createSessionToken: () => 'token' } } }
  const fs = {
    writeFileSync: (p: string, data: string) => {
      if (!p.startsWith('plugin-temp:/')) throw new Error('Route not found')
      written[p] = data
    },
    readFileSync: (p: string) => {
      if (!(opts.files && p in opts.files)) throw new Error('Route not found')
      return opts.files[p]
    },
  }
  const allowed: Record<string, unknown> = { photoshop, uxp, fs }
  const require = (m: string) => {
    if (!(m in allowed)) throw new Error(`Module not found: ${m}`)
    return allowed[m]
  }
  const ctx = vm.createContext({ // no TextEncoder/TextDecoder: Photoshop's script runtime has none
    require, console: { log() {}, error() {} }, Promise, Date, JSON, Math, Uint8Array, Float32Array, Array, Object, Error, String, Number, Set, Map })
  vm.runInContext(`(async () => {\n${script}\n})()`, ctx, { filename: 'color-detection.psjs' }) // top-level await → async wrapper (Node vm has no TLA)
  const done = () => new Promise<any>((resolve) => {
    const tick = () => (written['plugin-temp:/color-decision.json'] ? resolve(JSON.parse(written['plugin-temp:/color-decision.json'])) : setTimeout(tick, 5))
    tick()
  })
  return { done, written, calls }
}

const withoutRuntime = (r: any) => { const { runtime, ok, ...rest } = r; return rest }

let image: Img
let expected: any
let script: string
let embedded: string
beforeAll(async () => {
  await buildAll()
  script = readFileSync(join(POC, 'dist/color-detection.psjs'), 'utf8')
  embedded = readFileSync(join(POC, 'dist/color-detection.embedded.psjs'), 'utf8')
  const png = await makePng(540, 540, (x, y) => {
    const X = x * 2, Y = y * 2
    if (Y < 540) return Y >= 80 && Y < 170 && X >= 600 ? [238, 238, 238] : [20, 20, 30]
    return [235, 235, 235]
  })
  image = await raster.decodeImage(png)
  expected = detect.detectTextColors({ image, layout: config.textLayout, palette: config.palette, options: {} })
})

describe('Color Detection as a Photoshop UXP script (execute-actions sandbox, simulated)', () => {
  it('config via additionalContents[0] + imaging.getPixels → color-decision.json identical to the Custom Node', async () => {
    const apiScript = script.split('__ADDITIONAL_CONTENTS_PATH_0__').join('/job/in/additional-0.json') // what the API does
    const run = sandbox(apiScript, { image, files: { '/job/in/additional-0.json': JSON.stringify(config) } })
    const out = await run.done()
    expect(out.ok).toBe(true)
    expect(withoutRuntime(out)).toEqual(JSON.parse(JSON.stringify(expected)))
    expect(out.status).toBe('review')
    expect(out.runtime).toMatchObject({ pixelSource: 'imaging.getPixels', configSource: 'additionalContents[0]', engine: 'photoshop-uxp' })
    expect(run.calls).toContain('getPixels:sRGB IEC61966-2.1')
    expect(Object.keys(run.written)).toEqual(['plugin-temp:/color-decision.json'])
  })

  it('embedded config (node that only takes a script) gives the same result', async () => {
    const out = await sandbox(embedded, { image, components: 4 }).done()
    expect(out.runtime.configSource).toBe('embedded')
    expect(out.status).toBe('ok') // embedded = the Marderabwehr test config (different layout/palette)
  })

  it('without the imaging API: falls back to a RAW export of a flattened duplicate, same result', async () => {
    const apiScript = script.split('__ADDITIONAL_CONTENTS_PATH_0__').join('/job/in/additional-0.json')
    const run = sandbox(apiScript, { image, imaging: false, files: { '/job/in/additional-0.json': JSON.stringify(config) } })
    const out = await run.done()
    expect(out.runtime.pixelSource).toBe('raw-export')
    expect(out.runtime.imagingError).toMatch(/imaging API not available/)
    expect(withoutRuntime(out)).toEqual(JSON.parse(JSON.stringify(expected)))
    expect(run.calls).toEqual(['save'])
  })

  it('errors come back as JSON (the Photoshop job itself would still succeed)', async () => {
    const out = await sandbox(script, { image }).done() // placeholder not replaced, nothing embedded
    expect(out).toMatchObject({ ok: false, status: 'error' })
    expect(out.error).toMatch(/no configuration/)
    const bad = script.split('__ADDITIONAL_CONTENTS_PATH_0__').join('/job/in/additional-0.json')
    const out2 = await sandbox(bad, { image, files: { '/job/in/additional-0.json': JSON.stringify({ ...config, textLayout: { roles: [] } }) } }).done()
    expect(out2.error).toBe('"textLayout.roles" must be a non-empty array')
  })

  it('the bundle needs no module outside the sandbox allow-list', () => {
    const required = [...script.matchAll(/require\(["']([^"']+)["']\)/g)].map((m) => m[1])
    expect(new Set(required)).toEqual(new Set(['uxp']))
    expect(script).not.toMatch(/require\(["'](crypto|path|http|https|child_process|jimp)["']\)/)
  })

  it.runIf(existsSync(join(POC, 'test-data/marderabwehr_background_1080.png')))('Marderabwehr test data (if the client asset is present locally)', async () => {
    const img = await raster.decodeImage(readFileSync(join(POC, 'test-data/marderabwehr_background_1080.png')))
    const out = await sandbox(embedded, { image: img }).done()
    const exp = JSON.parse(readFileSync(join(POC, 'test-data/expected-marderabwehr.json'), 'utf8'))
    expect(withoutRuntime(out)).toEqual(exp)
  })
})
