// Color Decision ⇄ XMP (production carrier).
//
// The decision travels INSIDE the processed image as XMP metadata in our own
// namespace — no visible change, no extra pixels, no layers. XMP is stored
// uncompressed in every format the node can output (PNG iTXt "XML:com.adobe.xmp",
// JPEG APP1, TIFF tag 700, PSD resource 1060), so any downstream reader can find
// it by scanning the file bytes, and InDesign can read it from the placed image
// (Link.linkXmp.getProperty(NS, "tcd:ColorDecision")).
//
//   <rdf:Description rdf:about="" xmlns:tcd="NS">
//     <tcd:Status>ok|review|error</tcd:Status>
//     <tcd:ColorDecision>{compact JSON, XML-escaped}</tcd:ColorDecision>
//   </rdf:Description>
//
// Shared by the Photoshop script (write), the InDesign script and Node tools
// (read). Plain ES2019, no dependencies, no TextEncoder.

const NS = 'http://ns.territory-workflow.com/colordecision/1.0/'
const PREFIX = 'tcd'
const SCHEMA = 'territory.colorDecision/1'

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const unesc = (s) => String(s)
  .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
  .replace(/&#([0-9]+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)))
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')

// detect.js result → the compact, InDesign-oriented decision (what gets applied)
//   image: { width, height } of the analysed background (binds the decision to it)
function compactDecision(result, image, extra) {
  const d = {
    schema: SCHEMA,
    status: result.status,
    image: image ? { width: Math.round(image.width), height: Math.round(image.height) } : undefined,
    roles: result.roles.map((r) => ({
      role: r.role,
      readable: r.readable,
      readability: r.readability,
      threshold: r.threshold,
      weakestZone: r.contrast ? r.contrast.weakestZone : null,
      swatch: r.color ? { id: r.color.id, name: r.color.name, model: r.color.model, values: r.color.values, rgb: r.color.rgb, hex: r.color.hex } : null,
      ranking: (r.ranking || []).slice(0, 3).map((x) => [x.id, x.weakestZone]),
      warning: r.warning || null,
    })),
    warnings: result.warnings || [],
  }
  return extra ? Object.assign(d, extra) : d
}

function errorDecision(message, image) {
  return { schema: SCHEMA, status: 'error', error: String(message).slice(0, 500), image: image ? { width: Math.round(image.width), height: Math.round(image.height) } : undefined, roles: [], warnings: [] }
}

const DESC_RE = new RegExp(`<rdf:Description\\b[^>]*xmlns:${PREFIX}="[^"]*"[^>]*?(/>|>[\\s\\S]*?</rdf:Description>)`, 'g')

// Adds (or replaces) our rdf:Description in an XMP packet; '' → a minimal packet.
function insertIntoXmp(xmp, decision) {
  const block = `<rdf:Description rdf:about="" xmlns:${PREFIX}="${NS}"><${PREFIX}:Status>${esc(decision.status)}</${PREFIX}:Status><${PREFIX}:ColorDecision>${esc(JSON.stringify(decision))}</${PREFIX}:ColorDecision></rdf:Description>`
  let s = String(xmp || '')
  if (!/<\/rdf:RDF>/.test(s)) {
    return `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">${block}</rdf:RDF></x:xmpmeta><?xpacket end="w"?>`
  }
  s = s.replace(DESC_RE, '')
  return s.replace(/<\/rdf:RDF>/, block + '</rdf:RDF>')
}

// Finds our decision in any text that contains XMP (a packet string, or a whole
// image file read as latin1/UTF-8). Element and attribute forms (the XMP toolkit
// may re-serialize either way). Returns the parsed decision or null.
function extractFromXmp(text) {
  const s = String(text)
  const prefixes = new Set([PREFIX])
  const nsRe = /xmlns:([A-Za-z0-9_-]+)="([^"]*)"/g
  let m
  while ((m = nsRe.exec(s))) if (m[2] === NS) prefixes.add(m[1])
  for (const p of prefixes) {
    const el = new RegExp(`<${p}:ColorDecision>([\\s\\S]*?)</${p}:ColorDecision>`).exec(s)
    const at = el ? null : new RegExp(`\\b${p}:ColorDecision="([^"]*)"`).exec(s)
    const raw = el ? el[1] : at ? at[1] : null
    if (raw === null) continue
    try {
      const d = JSON.parse(unesc(raw))
      if (d && d.schema === SCHEMA) return d
    } catch (e) { /* try the next prefix */ }
  }
  return null
}

// The XMP packets of a whole image file (Uint8Array), UTF-8 decoded — cheap even
// for large TIFF/PSD, and keeps non-ASCII text intact (unlike a latin1 read).
function xmpTextFromBytes(bytes) {
  const { utf8Decode } = require('./payload.js')
  const open = [0x3c, 0x78, 0x3a, 0x78, 0x6d, 0x70, 0x6d, 0x65, 0x74, 0x61] // "<x:xmpmeta"
  const close = '</x:xmpmeta>'
  const at = (i, pat) => { for (let k = 0; k < pat.length; k++) if (bytes[i + k] !== pat[k]) return false; return true }
  const closeBytes = Array.from(close, (c) => c.charCodeAt(0))
  const parts = []
  for (let i = 0; i + open.length <= bytes.length; i++) {
    if (bytes[i] !== 0x3c || !at(i, open)) continue
    let j = i + open.length
    while (j + closeBytes.length <= bytes.length && !(bytes[j] === 0x3c && at(j, closeBytes))) j++
    parts.push(utf8Decode(bytes.subarray(i, Math.min(bytes.length, j + closeBytes.length))))
    i = j
  }
  return parts.join('\n')
}

module.exports = { NS, PREFIX, SCHEMA, compactDecision, errorDecision, insertIntoXmp, extractFromXmp, xmpTextFromBytes, esc, unesc }
