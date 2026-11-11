// Background pixels inside Photoshop (desktop and the Photoshop API / "Photoshop
// action V2" node — both verified, 2026-11-11):
//   1. imaging.getPixels (sRGB, 8 bit)              — primary
//   2. RAW copy saved to the temp folder, read back — fallback
// → { width, height, data: RGBA Uint8Array }
const req = (m) => require(m) // eslint-disable-line

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

// First method that works → { image, method, fallbackReason? }
async function readPixels(ps, doc) {
  try {
    return { image: await viaImaging(ps, doc), method: 'imaging.getPixels' }
  } catch (e) {
    const reason = String((e && e.message) || e).slice(0, 200)
    return { image: await viaRawExport(ps, doc), method: 'raw-export', fallbackReason: reason }
  }
}

module.exports = { toRgba, viaImaging, viaRawExport, readPixels }
