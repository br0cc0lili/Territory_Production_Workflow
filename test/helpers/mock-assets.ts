// Mock asset transport for offline tests: a fetch that serves Buffers for
// known HTTPS URLs, and an output store that keeps written files in memory
// and returns fake presigned HTTPS URLs.
import { Jimp } from 'jimp'

export function mockFetch(assets: Record<string, Buffer>) {
  const calls: string[] = []
  const fetch = async (url: string) => {
    calls.push(url)
    const body = assets[url]
    if (!body) return new Response('not found', { status: 404 })
    return new Response(new Uint8Array(body), { status: 200, headers: { 'content-length': String(body.length) } })
  }
  return Object.assign(fetch as unknown as typeof globalThis.fetch, { calls })
}

export function memoryStore() {
  const files = new Map<string, Buffer>()
  return {
    files,
    async put(path: string, bytes: Buffer) {
      files.set(path, Buffer.from(bytes))
      return `https://files.test.invalid/${path}?sig=presigned`
    },
    read(url: string) {
      const path = new URL(url).pathname.replace(/^\//, '')
      return files.get(path)
    },
  }
}

// Solid-colour or per-pixel PNG.
export async function makePng(width: number, height: number, pixel: (x: number, y: number) => [number, number, number]) {
  const img = new Jimp({ width, height, color: 0x000000ff })
  const d = img.bitmap.data
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      const [r, g, b] = pixel(x, y)
      d[i] = r
      d[i + 1] = g
      d[i + 2] = b
      d[i + 3] = 255
    }
  }
  return img.getBuffer('image/png')
}
