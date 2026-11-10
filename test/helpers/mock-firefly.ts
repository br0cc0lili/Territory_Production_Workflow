// Mock of the Firefly Services HTTP API (the three endpoints the reused
// territory-app client calls) behind a fetch function, plus static assets.
// Generated output: the requested canvas filled with GENERATED green, with
// the uploaded working source pasted at the inset — slightly TINTED, like
// Firefly's own (not bit-exact) copy of the original, so tests can prove the
// node puts the true original back.
import { Jimp } from 'jimp'

export const FIREFLY = 'https://firefly-api.adobe.io'
export const GENERATED: [number, number, number] = [0, 200, 0]

export interface MockFireflyOptions {
  assets?: Record<string, Buffer>
  /** status polls answered "running" before the terminal state */
  runningPolls?: number
  /** job numbers (1-based, submit order) that end "failed" */
  failJobs?: number[]
  /** uniform scale of the returned output vs the requested size (Firefly may rescale) */
  outputScale?: number
  tint?: number
}

export function mockFireflyApi(opts: MockFireflyOptions = {}) {
  const assets: Record<string, Buffer> = { ...(opts.assets ?? {}) }
  const uploads = new Map<string, Buffer>()
  const jobs: { jobId: string; n: number; body: any; polls: number; outputUrl?: string }[] = []
  const requests: { method: string; url: string; headers: Record<string, string> }[] = []
  const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } })

  async function render(job: (typeof jobs)[number]) {
    const { size, placement, image } = job.body
    const src = await Jimp.read(uploads.get(image.source.uploadId)!)
    const tint = opts.tint ?? 12
    src.scan((_x, _y, i) => { src.bitmap.data[i] = Math.min(255, src.bitmap.data[i] + tint) })
    const out = new Jimp({ width: size.width, height: size.height, color: (GENERATED[0] << 24) | (GENERATED[1] << 16) | (GENERATED[2] << 8) | 0xff })
    out.composite(src, placement.inset.left, placement.inset.top)
    const s = opts.outputScale ?? 1
    if (s !== 1) out.resize({ w: Math.round(size.width * s), h: Math.round(size.height * s) })
    const url = `https://firefly-output.test.invalid/${job.n}.png`
    assets[url] = await out.getBuffer('image/png')
    return url
  }

  const fetch = async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input)
    const method = (init.method ?? 'GET').toUpperCase()
    requests.push({ method, url, headers: { ...(init.headers as Record<string, string>) } })
    if (method === 'POST' && url === `${FIREFLY}/v2/storage/image`) {
      const id = `upload-${uploads.size + 1}`
      uploads.set(id, Buffer.from(init.body as Uint8Array))
      return json({ images: [{ id }] })
    }
    if (method === 'POST' && url === `${FIREFLY}/v3/images/expand-async`) {
      const body = JSON.parse(String(init.body))
      const n = jobs.length + 1
      const jobId = `urn:ff:jobs:test:${n}`
      jobs.push({ jobId, n, body, polls: 0 })
      return json({ jobId, statusUrl: `https://firefly-epo.test.invalid/v3/status/${jobId}` }, 202)
    }
    if (method === 'GET' && url.startsWith(`${FIREFLY}/v3/status/`)) {
      const job = jobs.find((j) => url.endsWith(j.jobId))
      if (!job) return json({ message: 'not found' }, 404)
      job.polls++
      if (job.polls <= (opts.runningPolls ?? 1)) return json({ jobId: job.jobId, status: 'running' })
      if (opts.failJobs?.includes(job.n)) return json({ jobId: job.jobId, status: 'failed', error: { message: 'mock content filter' } })
      job.outputUrl ??= await render(job)
      return json({ jobId: job.jobId, status: 'succeeded', result: { size: job.body.size, outputs: [{ seed: 1, image: { url: job.outputUrl } }] } })
    }
    const body = assets[url]
    if (method === 'GET' && body) return new Response(new Uint8Array(body), { status: 200, headers: { 'content-length': String(body.length) } })
    return json({ message: 'not found' }, 404)
  }
  return { fetch: fetch as unknown as typeof globalThis.fetch, assets, uploads, jobs, requests }
}
