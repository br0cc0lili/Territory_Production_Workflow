// DIAGNOSTIC (not production): how does the "Photoshop action V2" node hand its
// optional inputs to the script? Needed to let designers pick palette colours
// per run without generating config PNGs:
//   - which placeholders are replaced (Assets, input[0], …) and with what
//     (a path? inline text?), what the files are (PNG / CSV / JSON / text) and
//     how they start
//   - whether uxp.script.args, process.env or extra globals carry anything
// Shows the findings as a text layer on the image (diagnostic run only) and in
// the XMP caption "TCD1:{…}" (decode-carrier.mjs).
const ps = require('photoshop')
const fs = require('fs')

const C = {
  a0: '__ADDITIONAL_CONTENTS_PATH_0__', a1: '__ADDITIONAL_CONTENTS_PATH_1__', a2: '__ADDITIONAL_CONTENTS_PATH_2__',
  a3: '__ADDITIONAL_CONTENTS_PATH_3__', out: '__UXP_OUTPUT_PATH__',
  i0: '__INPUT_0__', i1: '__INPUT[0]__', i2: '{{input[0]}}', i3: '${input[0]}', i4: '__INPUT_PATH_0__', i5: '{{input_0}}', i6: '__INPUT_TEXT_0__',
}
const O = {
  a0: ['__ADDITIONAL', '_CONTENTS_PATH_0__'], a1: ['__ADDITIONAL', '_CONTENTS_PATH_1__'], a2: ['__ADDITIONAL', '_CONTENTS_PATH_2__'],
  a3: ['__ADDITIONAL', '_CONTENTS_PATH_3__'], out: ['__UXP', '_OUTPUT_PATH__'],
  i0: ['__INPUT', '_0__'], i1: ['__INPUT', '[0]__'], i2: ['{{input', '[0]}}'], i3: ['$', '{input[0]}'], i4: ['__INPUT', '_PATH_0__'], i5: ['{{input', '_0}}'], i6: ['__INPUT', '_TEXT_0__'],
}
const msg = (e) => String((e && e.message) || e).slice(0, 100)
const printable = (s) => String(s).replace(/[^\x20-\x7e]/g, '.').slice(0, 60)

function describe(bytes) {
  const b = new Uint8Array(bytes)
  const head = String.fromCharCode.apply(null, Array.from(b.subarray(0, 60)))
  const kind = b[0] === 0x89 && b[1] === 0x50 ? 'png' : b[0] === 0xff && b[1] === 0xd8 ? 'jpeg' : head.startsWith('ASEF') ? 'ase' : /^\s*[{[]/.test(head) ? 'json' : /[,;\t]/.test(head) ? 'csv/text' : 'text/other'
  return `${kind} ${b.length}B "${printable(head).slice(0, 40)}"`
}

async function main() {
  const doc = ps.app.activeDocument
  const r = { v: 'inputs1', w: doc.width, h: doc.height, ph: {} }
  for (const k of Object.keys(C)) {
    if (C[k] === O[k].join('')) continue
    let info = C[k].length > 34 ? `"...${printable(C[k].slice(-30))}"` : `"${printable(C[k])}"`
    try { info += ' -> ' + describe(fs.readFileSync(C[k])) } catch (e) { info += ` (not a file: ${msg(e)})` }
    r.ph[k] = info
  }
  try { const s = require('uxp').script; r.scriptArgs = s && s.args !== undefined ? printable(JSON.stringify(s.args)) : 'none' } catch (e) { r.scriptArgs = 'n/a ' + msg(e) }
  try { const env = require('process').env; r.env = env ? Object.keys(env).slice(0, 15).join(',') : 'none' } catch (e) { r.env = 'n/a' }
  try { r.globals = Object.keys(globalThis).filter((k) => !/^(console|require|module|exports|setTimeout|clearTimeout|setInterval|clearInterval|URL|fetch|performance|crypto|queueMicrotask|structuredClone|atob|btoa|global|globalThis|window|self|document|navigator|location|localStorage|sessionStorage|WebSocket|XMLHttpRequest|Blob|File|FileReader|FormData|Headers|Request|Response|AbortController|AbortSignal|Event|EventTarget)$/.test(k) && !/^(_|_internal.*|setImmediate|clearImmediate|devicePixelRatio|on[a-z]+|postMessage)$/.test(k)).slice(0, 15).join(',') } catch (e) {}
  const text = JSON.stringify(r)
  const lines = ['INPUT DISCOVERY (diagnostic run)', ...Object.keys(r.ph).map((k) => `${k}: ${r.ph[k]}`), `script.args: ${r.scriptArgs}`, `env: ${r.env}`, `globals: ${r.globals || '-'}`]
  if (!Object.keys(r.ph).length) lines.splice(1, 0, 'no placeholder replaced')
  try { await ps.app.batchPlay([{ _obj: 'set', _target: [{ _ref: 'property', _property: 'fileInfo' }, { _ref: 'document', _enum: 'ordinal', _value: 'targetEnum' }], to: { _obj: 'fileInfo', caption: 'TCD1:' + text } }], {}) } catch (e) {}
  const size = Math.max(12, Math.round(doc.height / 60))
  const px = (v) => ({ _unit: 'pixelsUnit', _value: v })
  try { // light panel behind the text so it reads on any background
    await ps.app.batchPlay([
      { _obj: 'make', _target: [{ _ref: 'layer' }], using: { _obj: 'layer', name: 'TCD inputs panel' } },
      { _obj: 'set', _target: [{ _ref: 'channel', _property: 'selection' }], to: { _obj: 'rectangle', top: px(0), left: px(0), bottom: px(Math.round(size * 1.25 * (lines.length + 1))), right: px(doc.width) } },
      { _obj: 'fill', using: { _enum: 'fillContents', _value: 'color' }, color: { _obj: 'RGBColor', red: 245, grain: 235, blue: 160 }, opacity: { _unit: 'percentUnit', _value: 100 }, mode: { _enum: 'blendMode', _value: 'normal' } },
      { _obj: 'set', _target: [{ _ref: 'channel', _property: 'selection' }], to: { _enum: 'ordinal', _value: 'none' } },
    ], {})
  } catch (e) {}
  try { await doc.createTextLayer({ name: 'TCD inputs', contents: lines.join('\r'), fontSize: size, position: { x: 12, y: size + 6 } }) } catch (e) {}
}
// top-level await: Photoshop drops pending async work once top-level code returns
await main()
