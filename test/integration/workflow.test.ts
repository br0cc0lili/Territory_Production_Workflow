// Integration: both nodes together, as a workflow would chain them, plus the
// web-action caller guard. Offline: mock assets, mocked Firefly HTTP API.
//   Image Extension (extendedImages) ──► Color Detection (background)
import { describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { resolveCredentials } from '@adobe/aio-lib-core-auth'
import { createColorDetectionHandler, REQUIRED_INPUTS as CD_REQUIRED } from '../../actions/color-detection/color-detection.worker'
import { createImageExtensionHandler, REQUIRED_INPUTS as IE_REQUIRED } from '../../actions/image-extension/image-extension.worker'
import { restrictCallers, parseAllowList } from '../../actions/shared/caller-guard'
import { runThroughSdk } from '../helpers/sdk-harness'
import { makePng, memoryStore } from '../helpers/mock-assets'
import { mockFireflyApi } from '../helpers/mock-firefly'

const SOURCE_URL = 'https://assets.test.invalid/source.png'
const INJECTED = { __ims_oauth_s2s: { client_id: 'test-client-id', client_secret: 'test-not-a-secret', org_id: 'TEST_ORG@AdobeOrg', scopes: ['firefly_api', 'ff_apis'] } }
const authLib = { resolveCredentials, generateAccessToken: async () => ({ access_token: 'test-access-token' }) }
const T = (id: string, w: number, h: number) => ({ id, canvas: { width: w, height: h }, placement: { x: 0, y: 0, width: 300, height: 200 } })

async function extend(targets: object[]) {
  // dark source; Firefly's generated area (mock) is green
  const api = mockFireflyApi({ assets: { [SOURCE_URL]: await makePng(300, 200, () => [25, 25, 35]) } })
  const store = memoryStore()
  const handler = createImageExtensionHandler({ fetch: api.fetch, store, authLib, sleep: async () => {}, pollIntervalMs: 0 })
  const r = await runThroughSdk({
    handler, requiredInputNames: IE_REQUIRED, workerArgs: INJECTED, beforeMount: (app) => restrictCallers(app),
    submit: { inputs: [
      { port: 'source', type: 'image', name: 'source.png', mimeType: 'image/png', url: SOURCE_URL },
      { port: 'layout', type: 'json', name: 'layout.json', mimeType: 'application/json', json: { targets } },
    ], parameters: {} },
  })
  return { r, store }
}

// What run-workflow would pass on along the connection extendedImages → background.
const asBackground = (outputs: any[]) => outputs.filter((o) => o.port === 'extendedImages').map((o) => ({ ...o, port: 'background' }))
const storeFetch = (store: ReturnType<typeof memoryStore>) => (async (url: string) => {
  const b = store.read(url)
  return b ? new Response(new Uint8Array(b), { status: 200 }) : new Response('nf', { status: 404 })
}) as unknown as typeof fetch

const textAndPalette = [
  // headline over the original (dark), subline over the generated bottom strip (green)
  { port: 'textLayout', type: 'json', name: 'text.json', mimeType: 'application/json', json: { roles: [
    { role: 'headline', fontSizePt: 60, lines: [[40, 20, 90, 280]] },
    { role: 'subline', fontSizePt: 24, lines: [[220, 20, 250, 280]] },
  ] } },
  { port: 'palette', type: 'json', name: 'palette.json', mimeType: 'application/json', json: { swatches: [
    { id: 'White', name: 'White', hex: '#ffffff' }, { id: 'Black', name: 'Black', hex: '#000000' },
  ] } },
]

describe('workflow chain: Image Extension → Color Detection', () => {
  it('one layout per job: the extended image feeds Color Detection; each role judged on its own area', async () => {
    const { r, store } = await extend([T('square_300x260', 300, 260)])
    expect(r.status!.status).toBe('completed')
    const background = asBackground(r.status!.outputs)
    expect(background).toHaveLength(1)

    const cd = await runThroughSdk({
      handler: createColorDetectionHandler({ fetch: storeFetch(store) }), requiredInputNames: CD_REQUIRED,
      beforeMount: (app) => restrictCallers(app),
      submit: { inputs: [...background, ...textAndPalette], parameters: {} },
    })
    expect(cd.status!.status).toBe('completed')
    const d = cd.status!.outputs[0].json
    expect(d.background).toEqual({ width: 300, height: 260 })
    expect(d.roles.map((x: any) => [x.role, x.color.name, x.readability])).toEqual([
      ['headline', 'White', 'OK'], // over the dark original
      ['subline', 'Black', 'OK'], // over the generated (green) extension
    ])
  })

  it('several layouts in one Image Extension job → several images on one port; Color Detection refuses a list instead of silently using the first', async () => {
    const { r, store } = await extend([T('square_300x260', 300, 260), T('tall_300x240', 300, 240)])
    const background = asBackground(r.status!.outputs)
    expect(background.map((b) => b.name)).toEqual(['square_300x260.png', 'tall_300x240.png'])
    // Undocumented in Adobe's public docs: does run-workflow fan these out (one
    // Color Detection run per image) or pass the list in one call? A list must
    // not be scored as if it were one image:
    const cd = await runThroughSdk({
      handler: createColorDetectionHandler({ fetch: storeFetch(store) }), requiredInputNames: CD_REQUIRED,
      submit: { inputs: [...background, ...textAndPalette], parameters: {} },
    })
    expect(cd.status!).toMatchObject({ status: 'failed', error: 'Port "background" received 2 items; Color Detection takes one per job (one layout per job)' })
    // fan-out case: each image on its own works
    for (const b of background) {
      const one = await runThroughSdk({
        handler: createColorDetectionHandler({ fetch: storeFetch(store) }), requiredInputNames: CD_REQUIRED,
        submit: { inputs: [b, ...textAndPalette], parameters: {} },
      })
      expect(one.status!.status).toBe('completed')
    }
  })

  it('Image Extension refuses several source images in one job', async () => {
    const handler = createImageExtensionHandler({ fetch: (async () => new Response('x')) as any, store: memoryStore() })
    const src = { port: 'source', type: 'image' as const, name: 's.png', mimeType: 'image/png', url: SOURCE_URL }
    const r = await runThroughSdk({ handler, requiredInputNames: IE_REQUIRED, submit: { inputs: [src, src, { port: 'layout', type: 'json', name: 'l', mimeType: 'application/json', json: { targets: [T('a', 300, 200)] } }], parameters: {} } })
    expect(r.status!.error).toBe('Port "source" received 2 items; Image Extension takes one source image per job')
  })
})

describe('caller guard (web actions)', () => {
  const echo = async () => ({ status: 'completed' as const, outputs: [] })
  const submit = { inputs: [], parameters: {} }
  it('allows run-workflow-service by default and rejects other IMS clients before any job is created', async () => {
    const ok = await runThroughSdk({ handler: echo, submit, beforeMount: (app) => restrictCallers(app) })
    expect(ok.submitRes.status).toBe(202)
    const other = await runThroughSdk({ handler: echo, submit, beforeMount: (app) => restrictCallers(app), apiKey: 'someone-elses-client' })
    expect(other.submitRes.status).toBe(403)
    expect(other.submitBody).toEqual({ error: 'Caller not allowed' })
    expect(other.jobStore.records.size).toBe(0)
    const missing = await runThroughSdk({ handler: echo, submit, beforeMount: (app) => restrictCallers(app), token: null })
    expect(missing.submitRes.status).toBe(401) // SDK: missing Authorization
  })
  it('the allow-list can be configured per deployment (action input); unset / unresolved → default', async () => {
    expect(parseAllowList('a, b ,')).toEqual(['a', 'b'])
    expect(parseAllowList('')).toBeNull()
    expect(parseAllowList('$ALLOWED_CALLER_CLIENT_IDS')).toBeNull()
    const app = new Hono()
    restrictCallers(app)
    app.post('/submit', (c) => c.json({ ok: true }))
    const call = (key: string, allow?: string) => app.request('/submit', { method: 'POST', headers: { 'x-api-key': key } }, { params: { ALLOWED_CALLER_CLIENT_IDS: allow } })
    expect((await call('my-test-client', 'my-test-client,run-workflow-service')).status).toBe(200)
    expect((await call('my-test-client', '$ALLOWED_CALLER_CLIENT_IDS')).status).toBe(403)
    expect((await call('run-workflow-service')).status).toBe(200)
  })
})

describe('public statusUrl (web actions)', () => {
  it('rewrites the SDK statusUrl (Runtime-internal host) to the public web-action URL = catalog statusEndpoint', async () => {
    const { usePublicStatusUrl } = await import('../../actions/shared/public-status-url')
    const saved = { ns: process.env.__OW_NAMESPACE, host: process.env.__OW_API_HOST }
    process.env.__OW_NAMESPACE = '44531-798fuchsiatarsier-stage'
    process.env.__OW_API_HOST = 'https://controller-gw-ns.int.example.adobe.net'
    try {
      const echo = async () => ({ status: 'completed' as const, outputs: [] })
      const r = await runThroughSdk({
        handler: echo, submit: { inputs: [], parameters: {} },
        beforeMount: (app) => { restrictCallers(app); usePublicStatusUrl(app, { packageName: 'territory-ffcpe-nodes', actionName: 'color-detection-web' }) },
      })
      expect(r.submitRes.status).toBe(202)
      expect(r.submitBody.statusUrl).toBe(`https://44531-798fuchsiatarsier-stage.adobeioruntime.net/api/v1/web/territory-ffcpe-nodes/color-detection-web/status?jobId=${r.submitBody.jobId}`)
      expect(r.status!.status).toBe('completed') // polling the rewritten URL's query still finds the job
      const rejected = await runThroughSdk({ handler: echo, submit: { inputs: [], parameters: {} }, apiKey: 'other', beforeMount: (app) => { restrictCallers(app); usePublicStatusUrl(app, { packageName: 'p', actionName: 'a' }) } })
      expect(rejected.submitRes.status).toBe(403) // non-202 responses untouched
    } finally {
      process.env.__OW_NAMESPACE = saved.ns
      process.env.__OW_API_HOST = saved.host
      if (saved.ns === undefined) delete process.env.__OW_NAMESPACE
      if (saved.host === undefined) delete process.env.__OW_API_HOST
    }
  })
})
