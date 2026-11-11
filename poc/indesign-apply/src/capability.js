// InDesign API (Firefly Services) Custom Scripts capability — UXP.
// Applies the Color Decision carried by the processed image(s) to the text of
// the populated template, saves the document and returns a per-page report.
//
// Contract (AdobeDocs/indesign-api-docs, UXP sample "idmlConversion"):
//   script.args[0] = 'parameters={"params":{…},"workingFolder":"…",…}'
//   assets of the request are downloaded into workingFolder under their
//   "destination" names; outputs listed in assetsToBeUploaded are uploaded;
//   the result goes back via script.setResult(JSON string).
//
// params:
//   targetDocument   (required) INDD, relative to the working folder
//   outputDocument   default "colored-<targetDocument>"
//   decisionImage    optional: processed image (asset) whose XMP carries the
//                    decision — applied to every page; without it each page's
//                    placed "<<MainImage>>" is read (link XMP, then the file)
//   expectConfigId   optional: refuse decisions made for a different config
//   textFrame / imageFrame / roles   override the plugin's conventions
//   failOnSkipped    true → FAILURE if any page could not be coloured
//   reportFile       default "color-decision-report.json" (uploaded with the INDD)
const core = require('./apply-core.js')
const X = require('../../photoshop-action-v2/src/decision-xmp.js')

const req = (m) => require(m) // eslint-disable-line
const msg = (e) => String((e && e.message) || e).slice(0, 500)

function resolveIn(base, rel) {
  if (typeof rel !== 'string' || !rel || rel.includes('..') || /^([\\/]|[A-Za-z]:)/.test(rel)) throw new Error(`invalid relative path: ${rel}`)
  const sep = base.includes('\\') && !base.includes('/') ? '\\' : '/'
  return base.replace(/[\\/]+$/, '') + sep + rel.replace(/[\\/]+/g, sep)
}

async function readBytes(path) {
  const uxp = req('uxp')
  const entry = await uxp.storage.localFileSystem.getEntryWithUrl('file:' + path)
  return new Uint8Array(await entry.read({ format: uxp.storage.formats.binary }))
}
const readFileText = async (path) => X.xmpTextFromBytes(await readBytes(path))

// core of the capability, also used by the local desktop test
async function applyToDocument(doc, idm, params, workingFolder) {
  const options = { textFrame: params.textFrame, imageFrame: params.imageFrame, roles: params.roles, expectConfigId: params.expectConfigId }
  Object.keys(options).forEach((k) => options[k] === undefined && delete options[k])
  let given = null
  if (params.decisionImage) {
    const decision = X.extractFromXmp(await readFileText(resolveIn(workingFolder, params.decisionImage)))
    given = { decision, source: `decisionImage ${params.decisionImage}` }
  }
  const pages = []
  for (let i = 0; i < doc.pages.length; i++) {
    const page = doc.pages.item(i)
    let r
    try { r = await core.applyToPage(doc, page, idm, options, given, readFileText) } catch (e) { r = { status: 'skipped', reason: msg(e), applied: [], warnings: [] } }
    pages.push(Object.assign({ page: String(page.name), label: String(page.label || '') }, r))
  }
  const count = (s) => pages.filter((p) => p.status === s).length
  return { pages, summary: { applied: count('applied'), review: count('review'), skipped: count('skipped') } }
}

async function main() {
  const idm = req('indesign')
  const uxp = req('uxp')
  const raw = String(uxp.script.args[0] || '')
  const all = JSON.parse(raw.slice(raw.indexOf('=') + 1))
  const params = all.params || (all.input && all.input.params)
  if (!params || typeof params !== 'object') throw new Error('missing params')
  const wf = all.workingFolder
  if (!params.targetDocument) throw new Error('params.targetDocument is required')
  const outRel = params.outputDocument || `colored-${params.targetDocument.split(/[\\/]/).pop()}`
  const doc = await idm.app.open(resolveIn(wf, params.targetDocument))
  try {
    const result = await applyToDocument(doc, idm, params, wf)
    doc.save(resolveIn(wf, outRel))
    const reportRel = params.reportFile || 'color-decision-report.json'
    const folder = await uxp.storage.localFileSystem.getEntryWithUrl('file:' + wf.replace(/[\\/]+$/, ''))
    const f = await folder.createFile(reportRel, { overwrite: true })
    await f.write(JSON.stringify(result, null, 2))
    if (params.failOnSkipped && result.summary.skipped) {
      return { status: 'FAILURE', errorCode: 'capability_error', errorString: `text colour not applied on ${result.summary.skipped} page(s)`, data: result }
    }
    return { status: 'SUCCESS', assetsToBeUploaded: [{ path: outRel, data: null }, { path: reportRel, data: null }], data: result.summary }
  } finally {
    try { doc.close(idm.SaveOptions.NO) } catch (e) { /* already closed */ }
  }
}

module.exports = { main, applyToDocument, resolveIn, findNamed: core.findNamed }
