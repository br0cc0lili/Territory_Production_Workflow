// Territory Color Detection — PRODUCTION script for Workflow Builder's
// "Photoshop action V2" node.
//
//   Input Image  background-only render (page with Headline/Subline hidden)
//   Assets       config PNG: { textLayout, palette, options } (make-config-png.mjs)
//   → Processed Image: the SAME pixels, plus the Color Decision as XMP in our
//     namespace (decision-xmp.js). No banner, no layers, no extra rows,
//     no other metadata touched.
//
// Errors:
//   - detection fails (bad config, no pixels, …) → the image still passes through,
//     with tcd:Status "error" and the message; the InDesign step refuses to apply
//     it and keeps the template colours (fail closed, visible in its report)
//   - the decision cannot be written into the image → the script throws, so the
//     node run fails instead of emitting an image without a decision
const detect = require('../../../src/nodes/color-detection/detect.js')
const X = require('./decision-xmp.js')
const { readConfigFile } = require('./config-input.js')
const { readPixels } = require('./pixels.js')

// replaced by the platform with the Assets file path (verified in Workflow Builder)
const CONFIG_PATH = '__ADDITIONAL_CONTENTS_PATH_0__'
const CONFIG_UNSET = ['__ADDITIONAL', '_CONTENTS_PATH_0__'].join('')

const req = (m) => require(m) // eslint-disable-line
const hostVersion = () => { try { const h = req('uxp').host; return h ? `${h.name} ${h.version}` : undefined } catch (e) { return undefined } }
const msg = (e) => String((e && e.message) || e).slice(0, 500)

async function modal(ps, fn) {
  try { return await fn() } catch (e) {
    if (!/modal/i.test(msg(e)) || !ps.core || !ps.core.executeAsModal) throw e
    return ps.core.executeAsModal(fn, { commandName: 'Territory Color Decision' })
  }
}

async function getXmp(ps, doc) {
  const r = await ps.app.batchPlay([{ _obj: 'get', _target: [{ _property: 'XMPMetadataAsUTF8' }, { _ref: 'document', _id: doc.id }] }], {})
  return (r && r[0] && r[0].XMPMetadataAsUTF8) || ''
}

// writes the decision and reads it back — throws unless it round-trips exactly
async function writeDecision(ps, doc, decision) {
  const xmp = X.insertIntoXmp(await getXmp(ps, doc), decision)
  await ps.app.batchPlay([{ _obj: 'set', _target: [{ _ref: 'property', _property: 'XMPMetadataAsUTF8' }, { _ref: 'document', _id: doc.id }], to: { _obj: 'document', XMPMetadataAsUTF8: xmp } }], {})
  const back = X.extractFromXmp(await getXmp(ps, doc))
  if (!back || JSON.stringify(back) !== JSON.stringify(decision)) throw new Error('Color Decision could not be written into the image metadata')
}

async function run() {
  const ps = req('photoshop')
  const fs = req('fs')
  const doc = ps.app.activeDocument
  if (!doc) throw new Error('no input image (no active document)')
  const t0 = Date.now()
  const size = { width: doc.width, height: doc.height }
  let decision
  try {
    if (CONFIG_PATH === CONFIG_UNSET) throw new Error('no config — connect the config PNG to the Assets port')
    const { config, source } = readConfigFile(fs, CONFIG_PATH)
    const px = await readPixels(ps, doc)
    const result = detect.detectTextColors({ image: px.image, layout: config.textLayout, palette: config.palette, options: config.options || {} })
    decision = X.compactDecision(result, px.image, {
      engine: { name: 'photoshop-action-v2', pixels: px.method, config: source, ms: Date.now() - t0, host: hostVersion() },
    })
    if (px.fallbackReason) decision.engine.pixelsFallbackReason = px.fallbackReason
    if (config.id) decision.configId = String(config.id).slice(0, 120)
  } catch (e) {
    decision = X.errorDecision(msg(e), size)
  }
  await modal(ps, () => writeDecision(ps, doc, decision))
  return decision
}

module.exports = { run, writeDecision, getXmp }
