// Baseline: shared asset/param helpers and the SDK harness itself.
import { describe, expect, it } from 'vitest'
import { createImageOutput, createJsonOutput, getJsonInput, type FfcpeNodeWorkerHandler } from '@adobe/ffcpe-custom-node-core'
import { runThroughSdk } from '../helpers/sdk-harness'
import { mockFetch, memoryStore, makePng } from '../helpers/mock-assets'
import assets from '../../src/shared/assets.js'
import params from '../../src/shared/params.js'
import raster from '../../src/shared/raster.js'

describe('shared/assets', () => {
  it('fetches HTTPS assets and refuses other schemes', async () => {
    const fetch = mockFetch({ 'https://a.test/x.png': Buffer.from('abc') })
    expect((await assets.fetchAsset('https://a.test/x.png', { fetch })).toString()).toBe('abc')
    await expect(assets.fetchAsset('http://a.test/x.png', { fetch, what: 'background' })).rejects.toThrow(/background: URL must use HTTPS/)
    await expect(assets.fetchAsset('file:///etc/passwd', { fetch })).rejects.toThrow(/HTTPS/)
    await expect(assets.fetchAsset('https://a.test/missing.png', { fetch })).rejects.toThrow(/HTTP 404/)
  })
  it('caps the download size', async () => {
    const fetch = mockFetch({ 'https://a.test/big': Buffer.alloc(100) })
    await expect(assets.fetchAsset('https://a.test/big', { fetch, maxBytes: 50 })).rejects.toThrow(/exceeds/)
  })
  it('files store only writes under public/ and returns a presigned URL', async () => {
    const written: Record<string, Buffer> = {}
    const store = assets.createFilesStore({
      init: async () => ({
        write: async (p: string, b: Buffer) => { written[p] = b },
        generatePresignURL: async (p: string, o: any) => `https://files.test/${p}?exp=${o.expiryInSeconds}&perm=${o.permissions}`,
      }),
    })
    expect(await store.put('public/x/out.png', Buffer.from('1'))).toBe('https://files.test/public/x/out.png?exp=18000&perm=r')
    await expect(store.put('private/../x', Buffer.from('1'))).rejects.toThrow(/invalid output path/)
  })
})

describe('shared/params', () => {
  it('reads and validates numbers, booleans, enums, bounds', () => {
    expect(params.readNumber({ a: '3' }, 'a', { min: 0, max: 5 })).toBe(3)
    expect(params.readNumber({}, 'a', { def: 1 })).toBe(1)
    expect(() => params.readNumber({ a: 9 }, 'a', { min: 0, max: 5 })).toThrow(params.NodeInputError)
    expect(params.readBoolean({ b: 'true' }, 'b', false)).toBe(true)
    expect(() => params.readEnum({ e: 'x' }, 'e', ['a', 'b'], 'a')).toThrow(/one of: a, b/)
    expect(() => params.readBounds([0, 0, 0, 10], 'box')).toThrow(/bottom > top/)
  })
})

describe('shared/raster', () => {
  it('decodes PNG to RGBA', async () => {
    const png = await makePng(3, 2, () => [10, 20, 30])
    const img = await raster.decodeImage(png)
    expect([img.width, img.height, img.data.length]).toEqual([3, 2, 24])
    expect(Array.from(img.data.slice(0, 4))).toEqual([10, 20, 30, 255])
  })
})

describe('SDK harness (FFCPE submit → worker → status)', () => {
  const echo: FfcpeNodeWorkerHandler = async ({ inputs }) => ({
    status: 'completed',
    outputs: [
      createJsonOutput({ got: getJsonInput(inputs, 'data') }, { port: 'result', name: 'result.json' }),
      createImageOutput('https://files.test.invalid/a.png', { port: 'images', name: 'a.png' }),
      createImageOutput('https://files.test.invalid/b.png', { port: 'images', name: 'b.png' }),
    ],
  })
  const submit = { inputs: [{ port: 'data', type: 'json' as const, name: 'data.json', mimeType: 'application/json', json: { n: 1 } }], parameters: {} }

  it('submit returns 202 + statusUrl; status returns the outputs (several items may share a port)', async () => {
    const r = await runThroughSdk({ handler: echo, submit, requiredInputNames: ['data'] })
    expect(r.submitRes.status).toBe(202)
    expect(r.submitBody.status).toBe('processing')
    expect(r.submitBody.statusUrl).toMatch(/\/api\/v1\/web\/.+\/territory-ffcpe-nodes\/test-web\/status\?jobId=/)
    expect(r.statusRes!.status).toBe(200)
    expect(r.status!.status).toBe('completed')
    expect(r.status!.outputs).toHaveLength(3)
    expect(r.status!.outputs[0].json).toEqual({ got: { n: 1 } })
    expect(r.status!.outputs.filter((o: any) => o.port === 'images').map((o: any) => o.name)).toEqual(['a.png', 'b.png'])
  })
  it('missing required input → job failed with the SDK message', async () => {
    const r = await runThroughSdk({ handler: echo, submit: { inputs: [], parameters: {} }, requiredInputNames: ['data'] })
    expect(r.status!.status).toBe('failed')
    expect(r.status!.error).toBe('Missing required input: data')
    expect(r.statusRes!.status).toBe(500)
  })
  it('IMS inbound auth is enforced (no token → 401, nothing runs)', async () => {
    const r = await runThroughSdk({ handler: echo, submit, token: null })
    expect(r.submitRes.status).toBe(401)
    expect(r.jobStore.records.size).toBe(0)
  })
})
