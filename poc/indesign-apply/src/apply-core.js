// Applies a Color Decision (decision-xmp.js) to the text of an InDesign page.
// Same conventions as the Territory InDesign plugin (render.js, c19c056):
//   - text frame named "<<Headline>>"; headline = its 1st non-empty paragraph,
//     subline = the 2nd
//   - a palette swatch becomes a document colour of the same name, created once
//     in its own model (palette.js inDesignColor) — an existing colour of that
//     name (e.g. from the template's ASE import) is reused
//   - the choice is recorded on the frame (label "posterBatch.textColor", v2),
//     which the plugin's pageWarnings() already reads
//   - below the readability threshold the best approved colour is STILL applied
//     and reported (status "review"), exactly as the plugin does
// Status "error", a missing/foreign decision or a config mismatch → nothing is
// applied (template colours stay) and the page is reported.
//
// DOM-generic: works with InDesign's UXP DOM and with test doubles.
const X = require('../../photoshop-action-v2/src/decision-xmp.js')
const { inDesignColor } = require('../../../src/core/palette.js')

const DEFAULTS = {
  textFrame: '<<Headline>>',
  imageFrame: '<<MainImage>>',
  roles: { headline: 0, subline: 1 }, // role → n-th non-empty paragraph of the text frame
  label: 'posterBatch.textColor',
}

const itemsOf = (coll) => { const out = []; for (let i = 0; i < coll.length; i++) out.push(coll.item ? coll.item(i) : coll[i]); return out }
const paragraphText = (p) => String(p.contents || '').replace(/[\r\n\u2028\u2029\uFEFF]/g, '').trim()

function findNamed(page, name, wantText) {
  for (const it of itemsOf(page.allPageItems)) {
    try {
      const isText = it.constructor && it.constructor.name === 'TextFrame'
      if (it.name === name && isText === wantText) return it
    } catch (e) { /* skip invalid items */ }
  }
  return null
}

// → { ok, reason? }
function validateDecision(d, opts) {
  if (!d) return { ok: false, reason: 'no Color Decision found' }
  if (d.schema !== X.SCHEMA) return { ok: false, reason: `unknown decision schema ${d.schema}` }
  if (d.status === 'error') return { ok: false, reason: `Color Detection failed: ${d.error || 'unknown error'}` }
  if (!['ok', 'review'].includes(d.status)) return { ok: false, reason: `unexpected status ${d.status}` }
  if (opts && opts.expectConfigId && d.configId !== opts.expectConfigId) return { ok: false, reason: `decision is for config ${d.configId || '(none)'}, expected ${opts.expectConfigId}` }
  if (!Array.isArray(d.roles) || !d.roles.length) return { ok: false, reason: 'decision has no roles' }
  return { ok: true }
}

// swatch → { space: 'RGB'|'CMYK'|'LAB', values } (hex-only swatches → RGB)
function colorSpec(swatch) {
  if (swatch.model && Array.isArray(swatch.values)) return inDesignColor(swatch)
  if (Array.isArray(swatch.rgb)) return { space: 'RGB', values: swatch.rgb.slice(0, 3) }
  throw new Error(`swatch ${swatch.id} has no colour values`)
}

function documentColorFor(doc, swatch, idm) {
  try { const c = doc.colors.itemByName(swatch.name); if (c && c.isValid) return c } catch (e) { /* create below */ }
  const spec = colorSpec(swatch)
  const space = spec.space === 'CMYK' ? idm.ColorSpace.CMYK : spec.space === 'LAB' ? idm.ColorSpace.LAB : idm.ColorSpace.RGB
  return doc.colors.add({ name: swatch.name, model: idm.ColorModel.PROCESS, space, colorValue: spec.values })
}

// Applies to one text frame → { status: 'applied'|'review'|'skipped', applied[], warnings[], reason? }
function applyDecisionToFrame(doc, frame, decision, idm, options) {
  const o = Object.assign({}, DEFAULTS, options || {})
  const check = validateDecision(decision, o)
  if (!check.ok) return { status: 'skipped', reason: check.reason, applied: [], warnings: [check.reason] }
  const paras = itemsOf(frame.parentStory.paragraphs)
  const nonEmpty = paras.map((p, i) => [p, i]).filter(([p]) => paragraphText(p) !== '').map(([, i]) => i)
  const applied = []
  const warnings = []
  const label = { v: 2 }
  for (const r of decision.roles) {
    const nth = o.roles[r.role]
    if (nth === undefined) { warnings.push(`role ${r.role} has no paragraph mapping — not applied`); continue }
    const pi = nonEmpty[nth]
    if (pi === undefined) { warnings.push(`role ${r.role}: frame has no paragraph #${nth + 1} — not applied`); continue }
    if (!r.swatch) { warnings.push(`role ${r.role}: no colour in decision — not applied`); continue }
    paras[pi].fillColor = documentColorFor(doc, r.swatch, idm)
    applied.push({ role: r.role, paragraph: pi, swatch: r.swatch.id, name: r.swatch.name, weakestZone: r.weakestZone, threshold: r.threshold, readable: r.readable })
    label[r.role] = { swatch: r.swatch.id, name: r.swatch.name, score: r.weakestZone, threshold: r.threshold, readable: r.readable }
    if (r.readable === false) warnings.push(`low text contrast — ${r.role} ${r.swatch.name} reaches ${r.weakestZone}:1 in its weakest part (needs ${r.threshold}:1); best of the selected colours`)
  }
  for (const w of decision.warnings || []) if (!warnings.includes(String(w))) warnings.push(String(w)) // detect.js uses the same wording
  try { frame.insertLabel(o.label, JSON.stringify(label)) } catch (e) { /* label is traceability only */ }
  return { status: decision.status === 'review' || applied.some((a) => a.readable === false) ? 'review' : 'applied', applied, warnings }
}

// Decision carried by a placed image: InDesign's link XMP first, the file bytes second.
//   readFileText(path) → Promise<string> (file read as UTF-8/latin1) | undefined
async function decisionFromGraphic(graphic, readFileText) {
  const link = graphic && graphic.itemLink
  if (!link) return { decision: null, source: 'no link' }
  try {
    const v = link.linkXmp.getProperty(X.NS, `${X.PREFIX}:ColorDecision`)
    if (v) {
      const d = JSON.parse(v)
      if (d && d.schema === X.SCHEMA) return { decision: d, source: 'linkXmp' }
    }
  } catch (e) { /* fall back to the file */ }
  if (readFileText) {
    try {
      const d = X.extractFromXmp(await readFileText(link.filePath))
      if (d) return { decision: d, source: 'link file' }
    } catch (e) { return { decision: null, source: `link file unreadable: ${String((e && e.message) || e).slice(0, 120)}` } }
  }
  return { decision: null, source: 'no decision in the placed image' }
}

// One page: text frame + (decision given, or read from the page's placed image)
async function applyToPage(doc, page, idm, options, given, readFileText) {
  const o = Object.assign({}, DEFAULTS, options || {})
  const frame = findNamed(page, o.textFrame, true)
  if (!frame) return { status: 'skipped', reason: `no text frame ${o.textFrame}`, applied: [], warnings: [] }
  let decision = given ? given.decision : null
  let source = given ? given.source : null
  if (!given) {
    const img = findNamed(page, o.imageFrame, false)
    const graphic = img && img.allGraphics && img.allGraphics.length ? (img.allGraphics.item ? img.allGraphics.item(0) : img.allGraphics[0]) : null
    const found = await decisionFromGraphic(graphic, readFileText)
    decision = found.decision
    source = img ? found.source : `no image frame ${o.imageFrame}`
  }
  const r = applyDecisionToFrame(doc, frame, decision, idm, o)
  return Object.assign({ source, configId: decision && decision.configId }, r)
}

module.exports = { DEFAULTS, validateDecision, colorSpec, documentColorFor, applyDecisionToFrame, decisionFromGraphic, applyToPage, findNamed, paragraphText }
