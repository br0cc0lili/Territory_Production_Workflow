// MINIMAL cloud smoke test for the "Photoshop action V2" node (no Color
// Detection code — small enough to paste into a text input).
// Proves: the script executes, and which pixel-reading method works.
// Reports through the Processed Image: a coloured bar at the top (GREEN = getPixels
// works, BLUE = only the RAW fallback works, RED = neither), a layer named with the
// details (PSD), and the details in the XMP caption ("TCD1:{...}").
// Also lists which placeholders the platform replaced (Assets / input[0] mapping).
const ps = require('photoshop')
const fs = require('fs')

const P = {
  a0: '__ADDITIONAL_CONTENTS_PATH_0__', a1: '__ADDITIONAL_CONTENTS_PATH_1__', a2: '__ADDITIONAL_CONTENTS_PATH_2__',
  out: '__UXP_OUTPUT_PATH__', i0: '__INPUT_0__', i1: '{{input[0]}}', i2: '${input[0]}',
}
const O = { a0: ['__ADDITIONAL', '_CONTENTS_PATH_0__'], a1: ['__ADDITIONAL', '_CONTENTS_PATH_1__'], a2: ['__ADDITIONAL', '_CONTENTS_PATH_2__'], out: ['__UXP', '_OUTPUT_PATH__'], i0: ['__INPUT', '_0__'], i1: ['{{input', '[0]}}'], i2: ['$', '{input[0]}'] }
const msg = (e) => String((e && e.message) || e).slice(0, 120)

async function main() {
  const doc = ps.app.activeDocument
  const r = { v: 'smoke1', ps: ps.app.version, w: doc.width, h: doc.height, mode: String(doc.mode), ph: {} }
  for (const k of Object.keys(P)) {
    if (P[k] === O[k].join('')) continue
    let info = P[k].slice(0, 80)
    try { const b = fs.readFileSync(P[k]); info += ` (${(b.byteLength || b.length)} bytes)` } catch (e) { info += ` (read: ${msg(e)})` }
    r.ph[k] = info
  }
  // method 1: imaging.getPixels
  let t = Date.now()
  try {
    const g = await ps.imaging.getPixels({ documentID: doc.id, componentSize: 8, colorSpace: 'RGB', colorProfile: 'sRGB IEC61966-2.1' })
    const d = await g.imageData.getData({ chunky: true })
    let sum = 0
    for (let i = 0; i < d.length; i += 97) sum += d[i]
    r.getPixels = `ok ${Date.now() - t}ms ${g.imageData.width}x${g.imageData.height}x${g.imageData.components} mean~${Math.round(sum / Math.ceil(d.length / 97))}`
    g.imageData.dispose()
  } catch (e) { r.getPixels = 'FAIL ' + msg(e) }
  // method 2: save a RAW copy to the temp folder and read it back
  t = Date.now()
  try {
    const lfs = require('uxp').storage.localFileSystem
    const f = await (await lfs.getTemporaryFolder()).createFile('smoke.raw', { overwrite: true })
    await ps.app.batchPlay([{ _obj: 'save', as: { _obj: 'rawFormat', fileCreator: '8BIM', channelsInterleaved: true }, in: { _path: lfs.createSessionToken(f), _kind: 'local' }, documentID: doc.id, copy: true, lowerCase: true }], {})
    const b = await f.read({ format: require('uxp').storage.formats.binary })
    r.raw = `ok ${Date.now() - t}ms ${b.byteLength} bytes`
  } catch (e) { r.raw = 'FAIL ' + msg(e) }
  const okG = r.getPixels.startsWith('ok'), okR = r.raw.startsWith('ok')
  const color = okG ? [40, 170, 80] : okR ? [40, 110, 220] : [210, 40, 40]
  const text = JSON.stringify(r)
  const steps = [
    ['caption', [{ _obj: 'set', _target: [{ _ref: 'property', _property: 'fileInfo' }, { _ref: 'document', _enum: 'ordinal', _value: 'targetEnum' }], to: { _obj: 'fileInfo', caption: 'TCD1:' + text } }]],
    ['bar', [
      { _obj: 'make', _target: [{ _ref: 'layer' }], using: { _obj: 'layer', name: ('TCD smoke ' + text).slice(0, 250) } },
      { _obj: 'set', _target: [{ _ref: 'channel', _property: 'selection' }], to: { _obj: 'rectangle', top: { _unit: 'pixelsUnit', _value: 0 }, left: { _unit: 'pixelsUnit', _value: 0 }, bottom: { _unit: 'pixelsUnit', _value: Math.max(60, Math.round(doc.height / 50) * 5) }, right: { _unit: 'pixelsUnit', _value: doc.width } } },
      { _obj: 'fill', using: { _enum: 'fillContents', _value: 'color' }, color: { _obj: 'RGBColor', red: color[0], grain: color[1], blue: color[2] }, opacity: { _unit: 'percentUnit', _value: 100 }, mode: { _enum: 'blendMode', _value: 'normal' } },
      { _obj: 'set', _target: [{ _ref: 'channel', _property: 'selection' }], to: { _enum: 'ordinal', _value: 'none' } },
    ]],
  ]
  for (const [name, descs] of steps) { try { await ps.app.batchPlay(descs, {}) } catch (e) { r['err_' + name] = msg(e) } }
  try { await doc.createTextLayer({ name: 'TCD smoke text', contents: `getPixels: ${r.getPixels}\rraw: ${r.raw}\rplaceholders: ${Object.keys(r.ph).join(', ') || 'none'}`, fontSize: Math.max(12, Math.round(doc.height / 50)), position: { x: 12, y: Math.max(12, Math.round(doc.height / 50)) + 6 } }) } catch (e) { r.err_text = msg(e) }
  try { fs.writeFileSync('plugin-temp:/smoke.json', JSON.stringify(r), 'utf8') } catch (e) {}
}
// top-level await: Photoshop drops pending async work once top-level code returns
await main()
