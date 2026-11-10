// Pixel payload: arbitrary UTF-8 text stored in RGB pixel bytes, so data can
// travel through image-only ports/outputs of Workflow Builder.
//
// Layout (row-major RGB, 3 bytes per pixel):
//   "TCD1" | length (uint32 BE) | UTF-8 bytes | zero padding
// Survives lossless formats (PNG, TIFF, PSD). Not JPEG — use the XMP caption there.
// Shared by the UXP script (encode/decode in Photoshop) and Node tools.

const MAGIC = 'TCD1'

function utf8Encode(s) { return new TextEncoder().encode(s) }
function utf8Decode(b) { return new TextDecoder('utf-8').decode(b) }

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

module.exports = { MAGIC, encodePixelPayload, decodePixelPayload }
