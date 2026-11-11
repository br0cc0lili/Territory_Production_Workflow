// Reads the Color Detection result back from the node's "Processed Image"
// (PNG / JPEG / PSD / TIFF), from every channel the probe writes:
//   xmp       XMP dc:description "TCD1:<compact JSON>"   (any format, if metadata kept)
//   strip     full report in the bottom pixel rows        (PNG / TIFF; jimp-readable)
//   layers    PSD layer names "TCD <role>=<swatch id> <OK|LOW>"
//
//   node poc/photoshop-action-v2/decode-carrier.mjs <processed image>
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { decodePixelPayload, MAGIC } = require('./src/payload.js')

const xmlUnescape = (s) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#xA;/g, '\n').replace(/&#xD;/g, '\r').replace(/&amp;/g, '&')

export function fromXmp(bytes) {
  const s = Buffer.from(bytes).toString('utf8')
  const out = []
  let i = -1
  while ((i = s.indexOf('<x:xmpmeta', i + 1)) !== -1) {
    const end = s.indexOf('</x:xmpmeta>', i)
    if (end < 0) break
    const xmp = s.slice(i, end)
    const m = xmp.match(/<dc:description>[\s\S]*?<rdf:li[^>]*>([\s\S]*?)<\/rdf:li>/)
    if (m) {
      const text = xmlUnescape(m[1])
      if (text.startsWith(MAGIC + ':')) { try { out.push(JSON.parse(text.slice(MAGIC.length + 1))) } catch (e) { out.push({ parseError: e.message }) } }
    }
  }
  return out[0] || null
}

export function fromLayerNames(bytes) {
  // PSD keeps the full layer name as UTF-16BE ('luni'); dropping NUL bytes makes it searchable
  const s = Buffer.from(bytes).toString('latin1').replace(/\x00/g, '')
  return [...new Set([...s.matchAll(/TCD [A-Za-z0-9 _-]{1,40}=[^\x00-\x1f]{1,200}? (OK|LOW|NO_DATA)/g)].map((m) => m[0].slice(m[0].lastIndexOf('TCD '))))]
}

export async function fromStrip(bytes) {
  try {
    const { Jimp } = require('jimp')
    const img = await Jimp.read(Buffer.from(bytes))
    const t = decodePixelPayload({ width: img.bitmap.width, height: img.bitmap.height, data: img.bitmap.data })
    return t ? JSON.parse(t) : null
  } catch (e) {
    return null // JPEG artefacts, PSD (not jimp-readable), no strip
  }
}

export async function decodeCarrier(bytes) {
  return { xmp: fromXmp(bytes), strip: await fromStrip(bytes), layers: fromLayerNames(bytes) }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const f = process.argv[2]
  if (!f) { console.error('usage: decode-carrier.mjs <processed image>'); process.exit(2) }
  const r = await decodeCarrier(readFileSync(f))
  console.log(JSON.stringify({
    xmp: r.xmp,
    strip: r.strip && { ok: r.strip.ok, status: r.strip.decision && r.strip.decision.status, summary: r.strip.decision && r.strip.decision.summary, pixels: r.strip.pixels, placeholders: r.strip.placeholders, configSource: r.strip.configSource, outputs: r.strip.outputs, error: r.strip.error },
    layers: r.layers,
  }, null, 2))
}
