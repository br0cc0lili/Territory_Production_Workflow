// Packs a Color Detection config ({ textLayout, palette, options }) into a PNG
// so it can travel through Workflow Builder's IMAGE-typed "Assets" input:
//   - iTXt chunk "territory-color-detection" (uncompressed UTF-8 JSON) — read
//     by the UXP script from the raw file bytes (no zlib needed)
//   - the same JSON in the pixels (payload.js) — fallback if the platform
//     re-encodes the asset and drops text chunks
//
//   node poc/photoshop-action-v2/make-config-png.mjs <config.json> <out.png>
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { Jimp } = require('jimp')
const { encodePixelPayload } = require('./src/payload.js')

export const CHUNK_KEY = 'territory-color-detection'

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
function crc32(buf) { let c = 0xffffffff; for (const b of buf) c = CRC_TABLE[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }

function iTXt(key, text) {
  const data = Buffer.concat([Buffer.from(key, 'latin1'), Buffer.from([0, 0, 0]), Buffer.from([0]), Buffer.from([0]), Buffer.from(text, 'utf8')])
  const type = Buffer.from('iTXt', 'latin1')
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([type, data])))
  return Buffer.concat([len, type, data, crc])
}

export async function makeConfigPng(configJson) {
  const text = JSON.stringify(JSON.parse(configJson))
  const width = 256
  const p = encodePixelPayload(text, width)
  const img = new Jimp({ width, height: p.height, color: 0x000000ff })
  for (let i = 0; i < width * p.height; i++) img.bitmap.data.set([p.data[i * 3], p.data[i * 3 + 1], p.data[i * 3 + 2], 255], i * 4)
  const png = await img.getBuffer('image/png')
  // insert iTXt right after IHDR (8-byte signature + 25-byte IHDR chunk)
  return Buffer.concat([png.subarray(0, 33), iTXt(CHUNK_KEY, text), png.subarray(33)])
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [inp, out] = process.argv.slice(2)
  if (!inp || !out) { console.error('usage: make-config-png.mjs <config.json> <out.png>'); process.exit(2) }
  const png = await makeConfigPng(readFileSync(inp, 'utf8'))
  writeFileSync(out, png)
  console.log(`wrote ${out} (${png.length} bytes)`)
}
