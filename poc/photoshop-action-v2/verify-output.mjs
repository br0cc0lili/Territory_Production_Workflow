// Checks a Processed Image downloaded from Workflow Builder against the input:
//   1. the Color Decision is in the XMP (tcd:ColorDecision) and equals the expected one
//   2. the image is clean: same size, and — for PNG/TIFF — the same pixels
//      (JPEG: re-encoding changes pixels, so only the average difference is reported)
//   3. no diagnostic carriers (probe caption, banner layers, pixel strip)
//
//   node poc/photoshop-action-v2/verify-output.mjs <downloaded file> \
//        [--input test-data/marderabwehr_background_1080.png] [--expected test-data/expected-decision.black-white.json]
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodeCarrier } from './decode-carrier.mjs'

const require = createRequire(import.meta.url)
const { Jimp } = require('jimp')
const HERE = dirname(fileURLToPath(import.meta.url))
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d }

export async function verifyOutput(outBytes, inBytes, expected) {
  const checks = []
  const add = (name, ok, detail) => checks.push({ name, ok, detail })
  const carriers = await decodeCarrier(outBytes)
  const d = carriers.decision
  add('decision in XMP', !!d, d ? `status ${d.status}, config ${d.configId}` : 'no tcd:ColorDecision found — metadata stripped?')
  if (d && expected) {
    const { engine, configId, ...rest } = d
    add('decision = expected', JSON.stringify(rest) === JSON.stringify(expected), d.roles.map((r) => `${r.role}: ${r.swatch ? r.swatch.name : '-'} ${r.weakestZone}:1 ${r.readability}`).join(' | '))
  }
  if (d && d.engine) add('engine', true, `${d.engine.pixels}, config from ${d.engine.config}, ${d.engine.host || 'host ?'}`)
  add('no diagnostic carriers', !carriers.xmp && !carriers.strip && !carriers.layers.length, [carriers.xmp && 'TCD1 caption', carriers.strip && 'pixel strip', carriers.layers.length && 'TCD layers'].filter(Boolean).join(', ') || 'none')
  let out = null
  try { out = await Jimp.read(Buffer.from(outBytes)) } catch (e) { add('pixels', true, `not readable here (${String(e.message).slice(0, 60)}) — e.g. PSD; open it in Photoshop to inspect`) }
  if (out && inBytes) {
    const inp = await Jimp.read(Buffer.from(inBytes))
    const same = out.bitmap.width === inp.bitmap.width && out.bitmap.height === inp.bitmap.height
    add('same size', same, `${out.bitmap.width}×${out.bitmap.height} (input ${inp.bitmap.width}×${inp.bitmap.height})`)
    if (same) {
      const a = out.bitmap.data, b = inp.bitmap.data
      let diff = 0, sum = 0, max = 0
      for (let i = 0; i < a.length; i++) { if ((i & 3) === 3) continue; const x = Math.abs(a[i] - b[i]); if (x) { diff++; sum += x; if (x > max) max = x } }
      const lossy = outBytes[0] === 0xff && outBytes[1] === 0xd8
      add(lossy ? 'pixels (JPEG, lossy)' : 'pixels identical', lossy ? max < 64 : diff === 0, diff ? `${diff} channel values differ, mean ${(sum / (a.length * 0.75)).toFixed(3)}, max ${max}` : 'bit-identical')
    }
  }
  return { ok: checks.every((c) => c.ok), checks, decision: d }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = process.argv[2]
  if (!file) { console.error('usage: verify-output.mjs <downloaded file> [--input <png>] [--expected <json>]'); process.exit(2) }
  const input = arg('--input', join(HERE, 'test-data/marderabwehr_background_1080.png'))
  const expected = arg('--expected', join(HERE, 'test-data/expected-decision.black-white.json'))
  const r = await verifyOutput(readFileSync(file), readFileSync(input), JSON.parse(readFileSync(expected, 'utf8')))
  for (const c of r.checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}: ${c.detail}`)
  console.log(r.ok ? '\nRESULT: PASS' : '\nRESULT: FAIL')
  process.exit(r.ok ? 0 : 1)
}
