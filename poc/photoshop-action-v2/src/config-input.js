// Reading the Color Detection config ({ textLayout, palette, options }) from
// the file the "Photoshop action V2" node hands the script for its Assets
// port (__ADDITIONAL_CONTENTS_PATH_0__ — verified in Workflow Builder,
// 2026-11-11). Assets is image-typed, so the config travels as a "config PNG"
// (make-config-png.mjs): JSON in an uncompressed iTXt chunk. A plain JSON file
// is accepted too.
const { utf8Encode, utf8Decode } = require('./payload.js')

const CONFIG_CHUNK = 'territory-color-detection'

function kindOf(b) {
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png'
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8) return 'jpeg'
  if (b.length > 4 && b[0] === 0x38 && b[1] === 0x42 && b[2] === 0x50 && b[3] === 0x53) return 'psd'
  const head = String.fromCharCode.apply(null, Array.from(b.subarray(0, 64))).trim()
  if (head.startsWith('{') || head.startsWith('[')) return 'json'
  return 'other'
}

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
        out[key] = utf8Decode(data.subarray(p))
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

const safeJson = (s) => { try { return JSON.parse(s) } catch (e) { return null } }
const looksLikeConfig = (o) => !!(o && typeof o === 'object' && o.textLayout && o.palette)

// → { config, source } or throws with a message that says what arrived instead
function readConfigFile(fs, path) {
  const bytes = asBytes(fs.readFileSync(path))
  const kind = kindOf(bytes)
  if (kind === 'json') {
    const j = safeJson(utf8Decode(bytes))
    if (looksLikeConfig(j)) return { config: j, source: 'assets (json)' }
    throw new Error('Assets file is JSON but not a { textLayout, palette } config')
  }
  if (kind === 'png') {
    const chunks = pngTextChunks(bytes)
    const j = safeJson(chunks[CONFIG_CHUNK] || '')
    if (looksLikeConfig(j)) return { config: j, source: 'assets (png text chunk)' }
    throw new Error(`Assets PNG has no "${CONFIG_CHUNK}" config chunk (chunks: ${Object.keys(chunks).join(', ') || 'none'})`)
  }
  throw new Error(`Assets file is ${kind}, expected the config PNG`)
}

module.exports = { CONFIG_CHUNK, kindOf, pngTextChunks, asBytes, safeJson, looksLikeConfig, readConfigFile }
