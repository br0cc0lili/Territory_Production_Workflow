// Color Detection as a Photoshop API v2 / Workflow Builder "Photoshop Action v2"
// UXP script — PROOF OF CONCEPT.
//
// Runs inside Photoshop's UXP script sandbox (execute-actions):
//   - the job's input image (the background-only render) is the active document
//   - per-run data (textLayout, palette, options) comes from a JSON file passed
//     as additionalContents[0] (__ADDITIONAL_CONTENTS_PATH_0__), or — if the
//     placeholder isn't replaced — from CONFIG embedded at build time
//   - pixels: imaging.getPixels (sRGB, 8 bit); fallback: export a flattened
//     copy as Photoshop RAW to plugin-temp:/ and read the bytes with fs
//   - scoring: the SAME code as the Custom Node (src/nodes/color-detection/
//     detect.js → src/core/textcolor.js, palette.js), bundled into this file
//   - result: plugin-temp:/color-decision.json (captured with
//     scriptOutputPattern "color-decision.json", mediaType application/json)
//
// Only allow-listed modules are used: photoshop, uxp, fs.

const detect = require('../../../src/nodes/color-detection/detect.js')

const OUTPUT = 'plugin-temp:/color-decision.json'
const CONFIG_PATH = '__ADDITIONAL_CONTENTS_PATH_0__'
// replaced at build time for the embedded-config variant (JSON string)
const EMBEDDED_CONFIG = '@@EMBEDDED_CONFIG@@'
const HAS_EMBEDDED = !EMBEDDED_CONFIG.startsWith('@@EMBEDDED')

function runtime() {
  // eslint-disable-next-line no-undef
  const req = typeof require === 'function' ? require : null
  return { ps: req('photoshop'), fs: req('fs') }
}

function readConfig(fs) {
  if (!CONFIG_PATH.startsWith('__ADDITIONAL')) {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8')
    return { config: JSON.parse(typeof raw === 'string' ? raw : require('./payload.js').utf8Decode(new Uint8Array(raw))), source: 'additionalContents[0]' }
  }
  if (HAS_EMBEDDED) return { config: JSON.parse(EMBEDDED_CONFIG), source: 'embedded' }
  throw new Error('no configuration: pass the JSON as additionalContents[0] or build with an embedded config')
}

// RGB(A) 8-bit -> { width, height, data: RGBA } as detect.js expects
function toRgba(width, height, components, bytes) {
  if (components === 4) return { width, height, data: bytes }
  const out = new Uint8Array(width * height * 4)
  for (let i = 0, j = 0; i < width * height; i++, j += components) {
    out[i * 4] = bytes[j]
    out[i * 4 + 1] = bytes[j + (components > 1 ? 1 : 0)]
    out[i * 4 + 2] = bytes[j + (components > 2 ? 2 : 0)]
    out[i * 4 + 3] = 255
  }
  return { width, height, data: out }
}

async function pixelsViaImaging(ps, doc) {
  if (!ps.imaging || typeof ps.imaging.getPixels !== 'function') throw new Error('imaging API not available')
  const r = await ps.imaging.getPixels({ documentID: doc.id, componentSize: 8, applyAlpha: true, colorSpace: 'RGB', colorProfile: 'sRGB IEC61966-2.1' })
  try {
    const id = r.imageData
    const bytes = await id.getData({ chunky: true })
    return toRgba(id.width, id.height, id.components, bytes)
  } finally {
    if (r.imageData && r.imageData.dispose) r.imageData.dispose()
  }
}

// Fallback: "save a copy" of the active document as Photoshop RAW (headerless,
// interleaved, flattened by the copy save) into the temp folder, read the bytes
// back. The job document itself is not changed. Requires an 8-bit RGB
// document; values are in the document's own colour profile (getPixels above
// converts to sRGB).
async function pixelsViaRawExport(ps, fs, doc) {
  const { app } = ps
  const lfs = require('uxp').storage.localFileSystem
  const width = Math.round(doc.width), height = Math.round(doc.height)
  if (!/RGB/i.test(String(doc.mode)) || !/8/.test(String(doc.bitsPerChannel))) throw new Error(`raw export needs an 8-bit RGB document (got ${doc.mode}, ${doc.bitsPerChannel})`)
  const tempFolder = await lfs.getTemporaryFolder()
  const file = await tempFolder.createFile('color-detection-background.raw', { overwrite: true })
  await app.batchPlay([{
    _obj: 'save',
    as: { _obj: 'rawFormat', fileCreator: '8BIM', channelsInterleaved: true },
    in: { _path: lfs.createSessionToken(file), _kind: 'local' },
    documentID: doc.id,
    copy: true,
    lowerCase: true,
  }], { modalBehavior: 'execute' })
  const buf = await file.read({ format: require('uxp').storage.formats.binary })
  const bytes = new Uint8Array(buf)
  const components = Math.round(bytes.length / (width * height))
  if (components < 3 || components * width * height !== bytes.length) throw new Error(`RAW export size ${bytes.length} doesn't match ${width}×${height}`)
  return toRgba(width, height, components, bytes)
}

async function readBackground(ps, fs, doc, log, force) {
  // PoC-only knob (config.poc.forcePixelSource = 'raw-export'): test the fallback where imaging exists
  if (force !== 'raw-export') try {
    const img = await pixelsViaImaging(ps, doc)
    log.pixelSource = 'imaging.getPixels'
    return img
  } catch (e) {
    log.imagingError = String(e && e.message || e)
  }
  if (force === 'raw-export') log.imagingError = 'skipped (poc.forcePixelSource)'
  const img = await pixelsViaRawExport(ps, fs, doc)
  log.pixelSource = 'raw-export'
  return img
}

async function run() {
  const { ps, fs } = runtime()
  const log = { startedAt: new Date().toISOString() }
  let result
  try {
    const doc = ps.app.activeDocument
    if (!doc) throw new Error('no active document (the job input image)')
    const { config, source } = readConfig(fs)
    log.configSource = source
    log.document = { name: doc.name, width: doc.width, height: doc.height, mode: String(doc.mode), bitsPerChannel: String(doc.bitsPerChannel) }
    const t0 = Date.now()
    const image = await readBackground(ps, fs, doc, log, config.poc && config.poc.forcePixelSource)
    log.readPixelsMs = Date.now() - t0
    const t1 = Date.now()
    result = detect.detectTextColors({ image, layout: config.textLayout, palette: config.palette, options: config.options || {} })
    log.scoringMs = Date.now() - t1
    result.ok = true
  } catch (e) {
    // errors are returned as JSON too: the job itself still "succeeds" in Photoshop's eyes
    result = { ok: false, status: 'error', error: String(e && e.message || e) }
  }
  result.runtime = Object.assign(log, { engine: 'photoshop-uxp', finishedAt: new Date().toISOString() })
  fs.writeFileSync(OUTPUT, JSON.stringify(result, null, 2), 'utf8')
  return result
}

module.exports = { run, toRgba, readConfig }
