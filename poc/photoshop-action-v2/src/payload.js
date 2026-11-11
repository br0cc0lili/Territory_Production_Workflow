// Pixel payload: arbitrary UTF-8 text stored in RGB pixel bytes, so data can
// travel through image-only ports/outputs of Workflow Builder.
//
// Layout (row-major RGB, 3 bytes per pixel):
//   "TCD1" | length (uint32 BE) | UTF-8 bytes | zero padding
// Survives lossless formats (PNG, TIFF, PSD). Not JPEG — use the XMP caption there.
// Shared by the UXP script (encode/decode in Photoshop) and Node tools.

const MAGIC = 'TCD1'

// Photoshop's UXP script runtime has no TextEncoder/TextDecoder (verified in
// Photoshop 27.10, UXP 9.4.1) — plain UTF-8 helpers instead.
function utf8Encode(str) {
  const out = []
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
      const d = str.charCodeAt(i + 1)
      if (d >= 0xdc00 && d <= 0xdfff) { c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00); i++ }
    }
    if (c < 0x80) out.push(c)
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63))
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
  }
  return Uint8Array.from(out)
}
function utf8Decode(b) {
  let s = ''
  for (let i = 0; i < b.length;) {
    const x = b[i++]
    let c
    if (x < 0x80) c = x
    else if (x < 0xe0) c = ((x & 31) << 6) | (b[i++] & 63)
    else if (x < 0xf0) { c = ((x & 15) << 12) | ((b[i] & 63) << 6) | (b[i + 1] & 63); i += 2 }
    else { c = ((x & 7) << 18) | ((b[i] & 63) << 12) | ((b[i + 1] & 63) << 6) | (b[i + 2] & 63); i += 3 }
    if (c > 0xffff) { c -= 0x10000; s += String.fromCharCode(0xd800 + (c >> 10), 0xdc00 + (c & 1023)) } else s += String.fromCharCode(c)
  }
  return s
}

// → { width, height, data: Uint8Array RGB }
function encodePixelPayload(text, width) {
  const body = utf8Encode(text)
  const total = 8 + body.length
  const height = Math.max(1, Math.ceil(total / 3 / width))
  const data = new Uint8Array(width * height * 3)
  for (let i = 0; i < 4; i++) data[i] = MAGIC.charCodeAt(i)
  data[4] = (body.length >>> 24) & 255; data[5] = (body.length >>> 16) & 255; data[6] = (body.length >>> 8) & 255; data[7] = body.length & 255
  data.set(body, 8)
  return { width, height, data }
}

// img: { width, height, data } with 3 or 4 bytes per pixel (RGBA if data.length = w*h*4).
// Scans rows for the magic; returns the text or null.
function decodePixelPayload(img) {
  const n = img.data.length === img.width * img.height * 4 ? 4 : 3
  const rgbAt = (pixel) => img.data.subarray(pixel * n, pixel * n + 3)
  const byteAt = (start, k) => rgbAt(start + Math.floor(k / 3))[k % 3]
  for (let row = 0; row < img.height; row++) {
    const start = row * img.width
    let ok = true
    for (let i = 0; i < 4 && ok; i++) ok = byteAt(start, i) === MAGIC.charCodeAt(i)
    if (!ok) continue
    const len = ((byteAt(start, 4) << 24) >>> 0) + (byteAt(start, 5) << 16) + (byteAt(start, 6) << 8) + byteAt(start, 7)
    if (len > (img.height - row) * img.width * 3) continue
    const out = new Uint8Array(len)
    for (let k = 0; k < len; k++) out[k] = byteAt(start, 8 + k)
    return utf8Decode(out)
  }
  return null
}

module.exports = { MAGIC, encodePixelPayload, decodePixelPayload, utf8Encode, utf8Decode }
