// Color Detection probe for Workflow Builder's "Photoshop action V2" node.
//
// Node interface (as seen in the UI): Input Image*, Script*, Fonts, Assets,
// input[0] → one output "Processed Image" (Original / JPEG / PNG / PSD / TIFF).
// The mapping of Assets / input[0] onto the Photoshop API (additionalContents
// placeholders?) is undocumented, so this script DISCOVERS it, then:
//   1. reads the background pixels (imaging.getPixels, and the RAW-export fallback)
//   2. finds the config ({ textLayout, palette, options }) in whatever arrived:
//      a JSON file, a "config PNG" (JSON in an iTXt/tEXt chunk, or encoded in
//      its pixels), a text value, or the config embedded at build time
//   3. runs the Custom Node's own detect.js
//   4. reports through the ONLY output, the processed image:
//        - status banner + text layer (visible in any format)
//        - XMP fileInfo caption "TCD1:<compact JSON>" (survives JPEG/PNG/PSD/TIFF if metadata kept)
//        - full report encoded in a pixel strip appended at the bottom (lossless formats)
//        - PSD: layer names "TCD …"
//      and also writes plugin-temp:/color-decision.json in case the platform surfaces it.
// Decode with: node poc/photoshop-action-v2/decode-carrier.mjs <processed image>

const detect = require('../../../src/nodes/color-detection/detect.js')
const { decodePixelPayload, encodePixelPayload, MAGIC, utf8Encode, utf8Decode } = require('./payload.js')

// Candidate placeholders — written as literals so a platform-side text
// replacement changes them; compared against strings rebuilt from parts.
const CANDIDATES = [
  ['additional[0]', '__ADDITIONAL_CONTENTS_PATH_0__'], ['additional[1]', '__ADDITIONAL_CONTENTS_PATH_1__'],
  ['additional[2]', '__ADDITIONAL_CONTENTS_PATH_2__'], ['additional[3]', '__ADDITIONAL_CONTENTS_PATH_3__'],
  ['additional[4]', '__ADDITIONAL_CONTENTS_PATH_4__'], ['additional[5]', '__ADDITIONAL_CONTENTS_PATH_5__'],
  ['uxpOutputPath', '__UXP_OUTPUT_PATH__'],
  ['input[0] a', '__INPUT_0__'], ['input[0] b', '__INPUT[0]__'], ['input[0] c', '{{input[0]}}'],
  ['input[0] d', '${input[0]}'], ['input[0] e', '__INPUT_PATH_0__'], ['assets a', '__ASSETS_PATH_0__'],
]
// originals rebuilt at runtime (joined from parts, so no build step or
// platform replacement can touch them)
const ORIGINAL = {
  'additional[0]': ['__ADDITIONAL', '_CONTENTS_PATH_0__'], 'additional[1]': ['__ADDITIONAL', '_CONTENTS_PATH_1__'],
  'additional[2]': ['__ADDITIONAL', '_CONTENTS_PATH_2__'], 'additional[3]': ['__ADDITIONAL', '_CONTENTS_PATH_3__'],
  'additional[4]': ['__ADDITIONAL', '_CONTENTS_PATH_4__'], 'additional[5]': ['__ADDITIONAL', '_CONTENTS_PATH_5__'],
  uxpOutputPath: ['__UXP', '_OUTPUT_PATH__'],
  'input[0] a': ['__INPUT', '_0__'], 'input[0] b': ['__INPUT', '[0]__'], 'input[0] c': ['{{input', '[0]}}'],
  'input[0] d': ['$', '{input[0]}'], 'input[0] e': ['__INPUT', '_PATH_0__'], 'assets a': ['__ASSETS', '_PATH_0__'],
}

const EMBEDDED_CONFIG = '@@EMBEDDED_CONFIG@@'
const HAS_EMBEDDED = !EMBEDDED_CONFIG.startsWith('@@EMBEDDED')

const req = (m) => require(m) // eslint-disable-line
const now = () => Date.now()
const errText = (e) => String((e && e.message) || e).slice(0, 300)

function kindOf(bytes) {
  const b = bytes
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png'
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8) return 'jpeg'
  if (b.length > 4 && b[0] === 0x38 && b[1] === 0x42 && b[2] === 0x50 && b[3] === 0x53) return 'psd'
  const head = String.fromCharCode.apply(null, Array.from(b.subarray(0, 64))).trim()
  if (head.startsWith('{') || head.startsWith('[')) return 'json'
  return 'other'
}

const utf8 = utf8Decode // no TextDecoder in Photoshop's script runtime

// PNG text chunks (tEXt, uncompressed iTXt) → { keyword: text }
function pngTextChunks(b) {
  const out = {}
  let i = 8
  while (i + 12 <= b.length) {
    const len = ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3]
    const type = String.fromCharCode(b[i + 4], b[i + 5], b[i + 6], b[i + 7])
    const data = b.subarray(i + 8, i + 8 + len)
    if (type === 'tEXt' || type === 'iTXt') {
      const z = data.indexOf(0)
      const key = String.fromCharCode.apply(null, Array.from(data.subarray(0, z)))
      if (type === 'tEXt') out[key] = String.fromCharCode.apply(null, Array.from(data.subarray(z + 1)))
      else if (data[z + 1] === 0) {
        let p = z + 3
        p = data.indexOf(0, p) + 1 // language tag
        p = data.indexOf(0, p) + 1 // translated keyword
        out[key] = utf8(data.subarray(p))
      }
    }
    if (type === 'IEND') break
    i += 12 + len
  }
  return out
}

function asBytes(x) {
  if (x instanceof Uint8Array) return x
  if (x instanceof ArrayBuffer) return new Uint8Array(x)
  if (typeof x === 'string') return utf8Encode(x)
  return new Uint8Array(x)
}

function looksLikeConfig(o) { return o && typeof o === 'object' && o.textLayout && o.palette }

async function probeInputs(fs, report) {
  const found = []
  for (const [key, literal] of CANDIDATES) {
    const original = ORIGINAL[key].join('')
    if (literal === original) continue
    const entry = { key, value: literal.length > 200 ? literal.slice(0, 200) + '…' : literal }
    report.placeholders.push(entry)
    if (key.startsWith('input[0]') && looksLikeConfig(safeJson(literal))) { entry.config = true; found.push({ source: key + ' (text)', config: safeJson(literal) }); continue }
    try {
      const bytes = asBytes(fs.readFileSync(literal))
      entry.bytes = bytes.length
      entry.kind = kindOf(bytes)
      if (entry.kind === 'json') {
        const j = safeJson(utf8(bytes))
        entry.json = !!j
        if (looksLikeConfig(j)) { entry.config = true; found.push({ source: key + ' (json file)', config: j }) }
      } else if (entry.kind === 'png') {
        const chunks = pngTextChunks(bytes)
        entry.pngText = Object.keys(chunks)
        const j = safeJson(chunks['territory-color-detection'] || '')
        if (looksLikeConfig(j)) { entry.config = true; found.push({ source: key + ' (png text chunk)', config: j }) } else entry.pngTextChunkLost = true
        entry.path = literal
      }
    } catch (e) {
      entry.readError = errText(e)
    }
  }
  return found
}

function safeJson(s) { try { return JSON.parse(s) } catch (e) { return null } }

function toRgba(width, height, components, bytes) {
  if (components === 4) return { width, height, data: bytes }
  const out = new Uint8Array(width * height * 4)
  for (let i = 0, j = 0; i < width * height; i++, j += components) {
    out[i * 4] = bytes[j]; out[i * 4 + 1] = bytes[j + 1]; out[i * 4 + 2] = bytes[j + 2]; out[i * 4 + 3] = 255
  }
  return { width, height, data: out }
}

async function viaImaging(ps, doc) {
  if (!ps.imaging || typeof ps.imaging.getPixels !== 'function') throw new Error('photoshop.imaging.getPixels not available')
  const r = await ps.imaging.getPixels({ documentID: doc.id, componentSize: 8, applyAlpha: true, colorSpace: 'RGB', colorProfile: 'sRGB IEC61966-2.1' })
  try {
    const d = r.imageData
    return toRgba(d.width, d.height, d.components, await d.getData({ chunky: true }))
  } finally { if (r.imageData && r.imageData.dispose) r.imageData.dispose() }
}

async function viaRawExport(ps, doc) {
  const uxp = req('uxp')
  const lfs = uxp.storage.localFileSystem
  const width = Math.round(doc.width), height = Math.round(doc.height)
  const folder = await lfs.getTemporaryFolder()
  const file = await folder.createFile('tcd-background.raw', { overwrite: true })
  await ps.app.batchPlay([{ _obj: 'save', as: { _obj: 'rawFormat', fileCreator: '8BIM', channelsInterleaved: true }, in: { _path: lfs.createSessionToken(file), _kind: 'local' }, documentID: doc.id, copy: true, lowerCase: true }], { modalBehavior: 'execute' })
  const bytes = new Uint8Array(await file.read({ format: uxp.storage.formats.binary }))
  const n = Math.round(bytes.length / (width * height))
  if (n < 3 || n * width * height !== bytes.length) throw new Error(`RAW size ${bytes.length} ≠ ${width}×${height}×n`)
  return toRgba(width, height, n, bytes)
}

// Config PNG whose text chunk was stripped: open it and read its pixel payload.
async function configFromPngPixels(ps, path, report) {
  const lfs = req('uxp').storage.localFileSystem
  const entry = await lfs.getEntryWithUrl(path.startsWith('file:') ? path : 'file:' + path)
  const cdoc = await ps.app.open(entry)
  try {
    const img = await viaImaging(ps, cdoc)
    return decodePixelPayload(img)
  } finally {
    await cdoc.closeWithoutSaving()
    report.configPngOpened = true
  }
}

async function modal(ps, fn) {
  try { return await fn() } catch (e) {
    if (!/modal/i.test(errText(e)) || !ps.core || !ps.core.executeAsModal) throw e
    return ps.core.executeAsModal(fn, { commandName: 'Territory Color Detection' })
  }
}

const bp = (ps, descs) => ps.app.batchPlay(descs, { modalBehavior: 'execute' })
const px = (v) => ({ _unit: 'pixelsUnit', _value: v })

async function newLayer(ps, name) { await bp(ps, [{ _obj: 'make', _target: [{ _ref: 'layer' }], using: { _obj: 'layer', name } }]) }
async function fillRect(ps, r, rgb) {
  await bp(ps, [
    { _obj: 'set', _target: [{ _ref: 'channel', _property: 'selection' }], to: { _obj: 'rectangle', top: px(r.top), left: px(r.left), bottom: px(r.bottom), right: px(r.right) } },
    { _obj: 'fill', using: { _enum: 'fillContents', _value: 'color' }, color: { _obj: 'RGBColor', red: rgb[0], grain: rgb[1], blue: rgb[2] }, opacity: { _unit: 'percentUnit', _value: 100 }, mode: { _enum: 'blendMode', _value: 'normal' } },
    { _obj: 'set', _target: [{ _ref: 'channel', _property: 'selection' }], to: { _enum: 'ordinal', _value: 'none' } },
  ])
}

function compactCarrier(report) {
  const d = report.decision
  return {
    v: 1, ok: report.ok, status: d ? d.status : 'error', error: report.error || undefined,
    pixels: report.pixels.used, config: report.configSource,
    roles: d ? d.roles.map((r) => ({ role: r.role, readability: r.readability, threshold: r.threshold,
      color: r.color && { id: r.color.id, name: r.color.name, model: r.color.model, values: r.color.values, hex: r.color.hex },
      weakestZone: r.contrast && r.contrast.weakestZone })) : [],
    warnings: d ? d.warnings : [],
  }
}

async function writeOutputs(ps, fs, doc, report) {
  const out = report.outputs
  const full = JSON.stringify(report)
  const carrier = JSON.stringify(compactCarrier(report))
  // XMP caption (dc:description)
  try {
    await bp(ps, [{ _obj: 'set', _target: [{ _ref: 'property', _property: 'fileInfo' }, { _ref: 'document', _enum: 'ordinal', _value: 'targetEnum' }], to: { _obj: 'fileInfo', caption: MAGIC + ':' + carrier } }])
    out.xmpCaption = carrier.length + ' chars'
  } catch (e) { out.xmpCaption = errText(e) }
  // visible banner + text
  const W = Math.round(doc.width), H = Math.round(doc.height)
  const fontPx = Math.max(12, Math.round(Math.min(W, H) / 45))
  const lines = [
    `TERRITORY COLOR DETECTION — ${report.ok ? report.decision.status.toUpperCase() : 'ERROR'}`,
    `pixels: ${report.pixels.used || 'none'} ${report.pixels.imaging} / raw ${report.pixels.raw}`,
    `config: ${report.configSource || 'none'}; placeholders: ${report.placeholders.map((p) => p.key + (p.kind ? '=' + p.kind : '')).join(', ') || 'none replaced'}`,
    report.ok ? report.decision.summary : `error: ${report.error}`,
  ]
  const color = !report.ok ? [210, 40, 40] : report.decision.status === 'ok' ? [40, 170, 80] : [235, 170, 30]
  try {
    await newLayer(ps, `TCD status ${report.ok ? report.decision.status : 'error'}`)
    await fillRect(ps, { top: 0, left: 0, bottom: Math.round(fontPx * 1.5 * lines.length + fontPx), right: W }, color)
    out.banner = 'ok'
  } catch (e) { out.banner = errText(e) }
  try {
    await doc.createTextLayer({ name: 'TCD report', contents: lines.join('\r'), fontSize: fontPx, position: { x: Math.round(fontPx * 0.6), y: Math.round(fontPx * 1.4) } })
    out.textLayer = 'ok'
  } catch (e) { out.textLayer = errText(e) }
  // PSD: compact decision in layer names (≤ 255 chars each)
  try {
    const roles = report.ok ? report.decision.roles : []
    for (const r of roles) await newLayer(ps, `TCD ${r.role}=${r.color ? r.color.id : '-'} ${r.readability}`.slice(0, 250))
    out.layerNames = roles.length + ' layers'
  } catch (e) { out.layerNames = errText(e) }
  // full report as a pixel strip at the bottom (lossless formats)
  try {
    if (!ps.imaging || !ps.imaging.putPixels) throw new Error('photoshop.imaging.putPixels not available')
    const strip = encodePixelPayload(full, W)
    await bp(ps, [{ _obj: 'canvasSize', height: px(H + strip.height), vertical: { _enum: 'verticalLocation', _value: 'top' }, horizontal: { _enum: 'horizontalLocation', _value: 'center' } }])
    await newLayer(ps, 'TCD data strip')
    const imageData = await ps.imaging.createImageDataFromBuffer(strip.data, { width: W, height: strip.height, components: 3, chunky: true, colorSpace: 'RGB', colorProfile: 'sRGB IEC61966-2.1' })
    await ps.imaging.putPixels({ documentID: doc.id, layerID: doc.activeLayers[0].id, imageData, targetBounds: { left: 0, top: H } })
    imageData.dispose()
    out.pixelStrip = `${strip.height} rows`
  } catch (e) { out.pixelStrip = errText(e) }
  // last, so it includes every output status above
  try { out.pluginTempJson = 'written'; fs.writeFileSync('plugin-temp:/color-decision.json', JSON.stringify(report, null, 2), 'utf8') } catch (e) { out.pluginTempJson = errText(e) }
}

async function run() {
  const ps = req('photoshop')
  const fs = req('fs')
  const report = { engine: 'photoshop-action-v2-probe', startedAt: new Date().toISOString(), ok: false, placeholders: [], pixels: {}, outputs: {} }
  try { report.globals = Object.keys(globalThis).filter((k) => !/^(console|require|module|exports|setTimeout|clearTimeout|setInterval|clearInterval|Text(En|De)coder|URL|fetch|performance|crypto|queueMicrotask|structuredClone|atob|btoa|global|globalThis|window|self|document|navigator|location|localStorage|sessionStorage|WebSocket|XMLHttpRequest|Blob|File|FileReader|FormData|Headers|Request|Response|AbortController|AbortSignal|Event|EventTarget|__colorDetection)$/.test(k)).slice(0, 40) } catch (e) {}
  try { report.versions = { photoshop: ps.app.version, uxp: req('process').version } } catch (e) {}
  let doc
  try {
    doc = ps.app.activeDocument
    if (!doc) throw new Error('no active document')
    report.document = { name: doc.name, width: doc.width, height: doc.height, mode: String(doc.mode), bits: String(doc.bitsPerChannel), profile: (() => { try { return doc.colorProfileName } catch (e) { return undefined } })() }
    // inputs
    const found = await probeInputs(fs, report)
    let config = found.length ? found[0].config : null
    report.configSource = found.length ? found[0].source : null
    if (!config) {
      const png = report.placeholders.find((p) => p.kind === 'png' && p.pngTextChunkLost && p.path)
      if (png) {
        try { const j = safeJson(await configFromPngPixels(ps, png.path, report)); if (looksLikeConfig(j)) { config = j; report.configSource = png.key + ' (png pixels)' } } catch (e) { report.configPngError = errText(e) }
      }
    }
    if (!config && HAS_EMBEDDED) { config = JSON.parse(EMBEDDED_CONFIG); report.configSource = 'embedded' }
    // pixels: try both methods, use the first that works
    let image = null
    let t = now()
    try { image = await viaImaging(ps, doc); report.pixels.imaging = `ok ${now() - t}ms`; report.pixels.used = 'imaging.getPixels' } catch (e) { report.pixels.imaging = 'failed: ' + errText(e) }
    t = now()
    try { const raw = await viaRawExport(ps, doc); report.pixels.raw = `ok ${now() - t}ms`; if (!image) { image = raw; report.pixels.used = 'raw-export' } else { let same = raw.data.length === image.data.length; for (let i = 0; same && i < raw.data.length; i += 4097) same = raw.data[i] === image.data[i]; report.pixels.rawMatchesImaging = same } } catch (e) { report.pixels.raw = 'failed: ' + errText(e) }
    if (!image) throw new Error('no pixel method worked')
    if (!config) throw new Error('no config found (Assets / input[0] / embedded)')
    t = now()
    report.decision = detect.detectTextColors({ image, layout: config.textLayout, palette: config.palette, options: config.options || {} })
    report.scoringMs = now() - t
    report.ok = true
  } catch (e) {
    report.error = errText(e)
  }
  report.finishedAt = new Date().toISOString()
  if (doc) await modal(ps, () => writeOutputs(ps, fs, doc, report)).catch((e) => { report.outputs.fatal = errText(e) })
  else { try { fs.writeFileSync('plugin-temp:/color-decision.json', JSON.stringify(report, null, 2), 'utf8') } catch (e) {} }
  return report
}

module.exports = { run, pngTextChunks, kindOf, compactCarrier }
