// Image Extension end to end through Adobe's FFCPE SDK (submit → worker →
// status) with mock upstream inputs and a mocked Firefly HTTP API. The real
// territory-app Firefly client and the real @adobe/aio-lib-core-auth
// credential parsing run; only the IMS token request is stubbed.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { resolveCredentials } from '@adobe/aio-lib-core-auth'
import { createImageExtensionHandler, PORTS, REQUIRED_INPUTS } from '../../actions/image-extension/image-extension.worker'
import { runThroughSdk } from '../helpers/sdk-harness'
import { memoryStore, makePng } from '../helpers/mock-assets'
import { FIREFLY, GENERATED, mockFireflyApi, type MockFireflyOptions } from '../helpers/mock-firefly'
import raster from '../../src/shared/raster.js'
import { checkEntry } from '../../scripts/validate-entries.mjs'

const ROOT = join(__dirname, '../..')
const fixture = JSON.parse(readFileSync(join(ROOT, 'test/fixtures/image-extension/mock-submission.json'), 'utf8'))
const SOURCE_URL = fixture.inputs[0].url
const pattern = (x: number, y: number): [number, number, number] => [x % 256, y % 256, (x * 3 + y * 7) % 256]

// What App Builder injects with include-ims-credentials (test values, not a real credential).
const INJECTED = {
  __ims_oauth_s2s: { client_id: 'test-client-id', client_secret: 'test-not-a-secret', org_id: 'TEST_ORG@AdobeOrg', scopes: ['openid', 'AdobeID', 'firefly_api', 'ff_apis'] },
}
let tokenRequests = 0
const authLib = { resolveCredentials, generateAccessToken: async () => { tokenRequests++; return { access_token: 'test-access-token' } } }

let sourcePng: Buffer
beforeAll(async () => { sourcePng = await makePng(300, 200, pattern) })

function setup(opts: MockFireflyOptions = {}, workerArgs: Record<string, unknown> = INJECTED) {
  const api = mockFireflyApi({ ...opts, assets: { [SOURCE_URL]: sourcePng, 'https://assets.test.invalid/not-an-image.png': Buffer.from('nope') } })
  const store = memoryStore()
  const handler = createImageExtensionHandler({ fetch: api.fetch, store, authLib, sleep: async () => {}, pollIntervalMs: 0 })
  const run = (submit: any) => runThroughSdk({ handler, requiredInputNames: REQUIRED_INPUTS, submit, workerArgs })
  return { api, store, run }
}
const withTargets = (ids: string[], parameters: object = {}) => ({
  ...fixture,
  parameters,
  inputs: fixture.inputs.map((i: any) => (i.port === 'layout' ? { ...i, json: { targets: i.json.targets.filter((t: any) => ids.includes(t.id)) } } : i)),
})
const pixel = (img: any, x: number, y: number) => Array.from(img.bitmap.data.subarray((y * img.bitmap.width + x) * 4, (y * img.bitmap.width + x) * 4 + 3))

describe('Image Extension via the FFCPE SDK', () => {
  it('mock submission: one shared Firefly master, one image per servable target, metadata', async () => {
    const { api, store, run } = setup()
    const r = await run(fixture)
    expect(r.status!.status).toBe('completed')

    // Firefly: exactly ONE upload + ONE expand for the two targets that need generation
    const posts = api.requests.filter((q) => q.method === 'POST')
    expect(posts.map((q) => q.url)).toEqual([`${FIREFLY}/v2/storage/image`, `${FIREFLY}/v3/images/expand-async`])
    for (const q of api.requests.filter((q) => q.url.startsWith(FIREFLY))) {
      expect(q.headers['X-Api-Key']).toBe('test-client-id')
      expect(q.headers.Authorization).toBe('Bearer test-access-token')
    }
    const body = api.jobs[0].body
    expect(body).toEqual({
      numVariations: 1,
      size: { width: 300, height: 280 },
      image: { source: { uploadId: 'upload-1' } },
      placement: { inset: { left: 0, top: 20, right: 0, bottom: 60 } },
      prompt: 'continue the wet asphalt and the evening sky',
    })
    // territory-app gate rule: source + inset == size
    const up = await raster.loadJimp(api.uploads.get('upload-1')!)
    expect([up.bitmap.width + body.placement.inset.left + body.placement.inset.right, up.bitmap.height + body.placement.inset.top + body.placement.inset.bottom]).toEqual([300, 280])

    // outputs: 3 images on ONE port (SDK passes the array through) + metadata
    const outputs = r.status!.outputs
    expect(outputs.map((o: any) => [o.port, o.type, o.name])).toEqual([
      ['extendedImages', 'image', 'landscape_300x200.png'],
      ['extendedImages', 'image', 'square_300x260.png'],
      ['extendedImages', 'image', 'tall_240x240.png'],
      ['extensionMetadata', 'json', 'extension-metadata.json'],
    ])
    expect(outputs[0].url).toMatch(/^https:\/\/files\.test\.invalid\/public\/image-extension\/[0-9a-f-]{36}\/landscape_300x200\.png/)

    const meta = outputs[3].json
    expect(meta.status).toBe('partial')
    expect(meta.summary).toBe('4 targets: 2 extended, 1 not required, 1 needs review')
    expect(meta.masters).toHaveLength(1)
    expect(meta.masters[0]).toMatchObject({ targets: ['square_300x260', 'tall_240x240'], status: 'succeeded', fireflyJobId: 'urn:ff:jobs:test:1', generated: { width: 300, height: 280, scale: 1 } })
    expect(meta.targets.map((t: any) => [t.id, t.status, t.masterId === meta.masters[0].id])).toEqual([
      ['landscape_300x200', 'not_required', false],
      ['square_300x260', 'extended', true],
      ['tall_240x240', 'extended', true],
      ['poster_300x400', 'needs_review', false],
    ])
    expect(meta.targets[3].warnings[0]).toMatch(/exceeds automatic generation limit/)
    expect(meta.targets[3].output).toBeNull()
    expect(meta.targets.slice(0, 3).every((t: any) => t.originalPreserved === true)).toBe(true)

    // pixels: original exactly (Firefly's tinted copy replaced), generated areas from Firefly
    const img = async (name: string) => raster.loadJimp(store.read(outputs.find((o: any) => o.name === name).url)!)
    const land = await img('landscape_300x200.png')
    expect(pixel(land, 299, 199)).toEqual(pattern(299, 199))
    const sq = await img('square_300x260.png')
    expect([sq.bitmap.width, sq.bitmap.height]).toEqual([300, 260])
    expect(pixel(sq, 10, 10)).toEqual(pattern(10, 10))
    expect(pixel(sq, 150, 199)).toEqual(pattern(150, 199))
    expect(pixel(sq, 150, 230)).toEqual(GENERATED)
    const tall = await img('tall_240x240.png')
    expect([tall.bitmap.width, tall.bitmap.height]).toEqual([240, 240])
    expect(pixel(tall, 0, 20)).toEqual(pattern(30, 0)) // cropped 30 px on the left
    expect(pixel(tall, 120, 5)).toEqual(GENERATED)
    expect(pixel(tall, 120, 230)).toEqual(GENERATED)
  })

  it('independent mode: one Firefly generation per target', async () => {
    const { api, run } = setup()
    const r = await run(withTargets(['square_300x260', 'tall_240x240'], { batchMode: 'independent' }))
    expect(r.status!.status).toBe('completed')
    expect(api.jobs.map((j) => j.body.size)).toEqual([{ width: 300, height: 260 }, { width: 300, height: 240 }])
    expect(r.status!.outputs.at(-1).json.status).toBe('completed')
  })

  it('allowLarge: the over-limit target joins the shared master', async () => {
    const { api, run } = setup()
    const r = await run({ ...fixture, parameters: { allowLarge: true } })
    expect(api.jobs).toHaveLength(1)
    expect(api.jobs[0].body.size).toEqual({ width: 300, height: 420 })
    const meta = r.status!.outputs.at(-1).json
    expect(meta.status).toBe('completed')
    expect(meta.targets[3].status).toBe('extended')
  })

  it('Firefly may return a uniformly rescaled output — still aligned', async () => {
    const { run, store } = setup({ outputScale: 0.5 })
    const r = await run(withTargets(['square_300x260']))
    const meta = r.status!.outputs.at(-1).json
    expect(meta.masters[0].generated).toMatchObject({ width: 150, height: 130, scale: 0.5 })
    const sq = await raster.loadJimp(store.read(r.status!.outputs[0].url)!)
    expect(pixel(sq, 150, 199)).toEqual(pattern(150, 199))
    expect(pixel(sq, 150, 240)).toEqual(GENERATED)
  })

  it('covered targets only: no Firefly call, no credential needed', async () => {
    const { api, run } = setup({}, {})
    const r = await run(withTargets(['landscape_300x200']))
    expect(r.status!.status).toBe('completed')
    expect(api.requests.some((q) => q.url.startsWith(FIREFLY))).toBe(false)
  })

  it('Firefly failure: job fails when no image can be produced; partial when some can', async () => {
    const failed = await setup({ failJobs: [1] }).run(withTargets(['square_300x260', 'tall_240x240']))
    expect(failed.status!.status).toBe('failed')
    expect(failed.status!.error).toMatch(/^No extended image produced — square_300x260: Firefly generation failed: mock content filter/)
    const partial = await setup({ failJobs: [2] }).run(withTargets(['square_300x260', 'tall_240x240'], { batchMode: 'independent' }))
    const meta = partial.status!.outputs.at(-1).json
    expect(meta.status).toBe('partial')
    expect(meta.targets.map((t: any) => t.status)).toEqual(['extended', 'failed'])
  })

  it('a Firefly job that never finishes times out (no endless polling)', async () => {
    const api = mockFireflyApi({ runningPolls: 1e9, assets: { [SOURCE_URL]: sourcePng } })
    let t = 0
    const handler = createImageExtensionHandler({ fetch: api.fetch, store: memoryStore(), authLib, sleep: async () => {}, now: () => (t += 10000), pollIntervalMs: 0, timeoutMs: 60000 })
    const r = await runThroughSdk({ handler, requiredInputNames: REQUIRED_INPUTS, submit: withTargets(['square_300x260']), workerArgs: INJECTED })
    expect(r.status!.error).toMatch(/Firefly generation failed: Firefly job did not finish within 60 s/)
    expect(api.jobs[0].polls).toBeLessThan(10)
  })

  it('credentials come only from the App Builder injection, never from workflow parameters', async () => {
    const before = tokenRequests
    const r = await setup({}, {}).run(withTargets(['square_300x260'], { __ims_oauth_s2s: INJECTED.__ims_oauth_s2s, clientId: 'x', clientSecret: 'y' }))
    expect(r.status!.status).toBe('failed')
    expect(r.status!.error).toMatch(/Firefly credential missing/)
    expect(tokenRequests).toBe(before)
    const noScope = await setup({}, { __ims_oauth_s2s: { ...INJECTED.__ims_oauth_s2s, scopes: ['openid'] } }).run(withTargets(['square_300x260']))
    expect(noScope.status!.error).toMatch(/lacks Firefly scope\(s\): firefly_api, ff_apis/)
  })

  it('input errors are failed jobs with clear messages', async () => {
    const { run } = setup()
    const set = (port: string, patch: object) => ({ ...fixture, inputs: fixture.inputs.map((i: any) => (i.port === port ? { ...i, ...patch } : i)) })
    expect((await run({ ...fixture, inputs: fixture.inputs.filter((i: any) => i.port !== 'layout') })).status!.error).toBe('Missing required input: layout')
    expect((await run(set('source', { url: 'https://assets.test.invalid/not-an-image.png' }))).status!.error).toBe('source: must be a JPEG or PNG image')
    expect((await run(set('source', { url: 'http://assets.test.invalid/x.png' }))).status!.error).toBe('source: URL must use HTTPS')
    expect((await run(set('prompt', { text: 'x'.repeat(1025) }))).status!.error).toBe('"prompt" must be text of at most 1024 characters')
    expect((await run({ ...fixture, parameters: { maxExtensionRatio: 0 } })).status!.error).toMatch(/maxExtensionRatio/)
  })
})

describe('catalog entry', () => {
  it("passes Adobe's catalog-entry validation; ports match the worker", () => {
    const { entry, errors, pending } = checkEntry(join(ROOT, 'actions/image-extension/image-extension.entry.json'))
    expect(errors).toEqual([])
    expect(pending).toBe(true)
    expect(entry.inputs.map((p: any) => p.name)).toEqual([PORTS.source, PORTS.layout, PORTS.prompt])
    expect(entry.inputs.filter((p: any) => p.required).map((p: any) => p.name)).toEqual(REQUIRED_INPUTS)
    expect(entry.outputs.map((p: any) => p.name)).toEqual([PORTS.extendedImages, PORTS.extensionMetadata])
    expect(entry.customActionConfig.authentication).toEqual({ type: 'ims_service_token' })
  })
})
