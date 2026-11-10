// Color Detection end to end through Adobe's FFCPE SDK (submit → worker →
// status) with mock upstream inputs — no network, no App Builder services.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { createColorDetectionHandler, PORTS, REQUIRED_INPUTS } from '../../actions/color-detection/color-detection.worker'
import { runThroughSdk } from '../helpers/sdk-harness'
import { makePng, mockFetch } from '../helpers/mock-assets'
import { BRAND_ASE } from '../helpers/ase'
import { checkEntry } from '../../scripts/validate-entries.mjs'

const ROOT = join(__dirname, '../..')
const fixture = JSON.parse(readFileSync(join(ROOT, 'test/fixtures/color-detection/mock-submission.json'), 'utf8'))
const BG_URL = fixture.inputs[0].url
const entryPath = join(ROOT, 'actions/color-detection/color-detection.entry.json')

let assets: Record<string, Buffer>
beforeAll(async () => {
  // 540 × 540 render of the 1080 pt page (0.5 px/pt): dark upper half with a
  // bright patch under the end of headline line 1, bright lower half.
  const background = await makePng(540, 540, (x, y) => {
    const X = x * 2, Y = y * 2
    if (Y < 540) return Y >= 80 && Y < 170 && X >= 600 ? [238, 238, 238] : [20, 20, 30]
    return [235, 235, 235]
  })
  assets = { [BG_URL]: background, 'https://assets.test.invalid/brand.ase': BRAND_ASE(), 'https://assets.test.invalid/broken.png': Buffer.from('not an image') }
})

const run = (submit: any) => runThroughSdk({ handler: createColorDetectionHandler({ fetch: mockFetch(assets) }), requiredInputNames: REQUIRED_INPUTS, submit })
const withInput = (port: string, patch: object) => ({ ...fixture, inputs: fixture.inputs.map((i: any) => (i.port === port ? { ...i, ...patch } : i)) })

describe('Color Detection via the FFCPE SDK', () => {
  it('mock submission: completed, colorDecision + readability outputs', async () => {
    const r = await run(fixture)
    expect(r.submitRes.status).toBe(202)
    expect(r.status!.status).toBe('completed')
    const outputs = r.status!.outputs
    expect(outputs.map((o: any) => [o.port, o.type, o.mimeType])).toEqual([
      ['colorDecision', 'json', 'application/json'],
      ['readability', 'text', 'text/plain'],
    ])
    const decision = outputs[0].json
    const [headline, subline] = decision.roles
    // headline: White fails on the bright patch, Black on the dark area → Audi Red, still below 3:1
    expect([headline.role, headline.color.name, headline.readability]).toEqual(['headline', 'Audi Red', 'LOW'])
    expect(headline.contrast.weakestZone).toBeLessThan(3)
    expect(headline.weakest.line).toBe(0)
    expect([subline.role, subline.color.name, subline.readability]).toEqual(['subline', 'Audi Black RGB', 'OK'])
    expect(decision.status).toBe('review')
    expect(outputs[1].text).toBe('review')
    expect(decision.candidates).toBe(3) // Silver is in the palette but not approved
    expect(decision.background).toEqual({ width: 540, height: 540 })
  })

  it('palette from an .ase URL', async () => {
    const r = await run(withInput('palette', { json: { aseUrl: 'https://assets.test.invalid/brand.ase', selectedIds: ['Brand/White', 'Brand/Black'] } }))
    expect(r.status!.status).toBe('completed')
    expect(r.status!.outputs[0].json.roles.map((x: any) => x.color.id)).toEqual(['Brand/White', 'Brand/Black'])
  })

  it('failures are reported as failed jobs with a clear message', async () => {
    const missing = await run({ ...fixture, inputs: fixture.inputs.filter((i: any) => i.port !== 'palette') })
    expect(missing.status!).toMatchObject({ status: 'failed', error: 'Missing required input: palette' })
    const http = await run(withInput('background', { url: 'http://assets.test.invalid/x.png' }))
    expect(http.status!).toMatchObject({ status: 'failed', error: 'background: URL must use HTTPS' })
    const notFound = await run(withInput('background', { url: 'https://assets.test.invalid/gone.png' }))
    expect(notFound.status!.error).toBe('background: download failed (HTTP 404)')
    const broken = await run(withInput('background', { url: 'https://assets.test.invalid/broken.png' }))
    expect(broken.status!.error).toMatch(/^Color Detection failed: /)
    const badLayout = await run(withInput('textLayout', { json: { roles: [] } }))
    expect(badLayout.status!.error).toBe('"textLayout.roles" must be a non-empty array')
    const lowThreshold = await run({ ...fixture, parameters: { largeTextThreshold: 99 } })
    expect(lowThreshold.status!.error).toBe('"largeTextThreshold" must be a number between 1 and 21')
  })

  it('JSON inputs may also arrive as text (SDK getJsonInput)', async () => {
    const layoutInput = fixture.inputs[1]
    const r = await run(withInput('textLayout', { type: 'text', mimeType: 'application/json', text: JSON.stringify(layoutInput.json), json: undefined }))
    expect(r.status!.status).toBe('completed')
  })
})

describe('catalog entry', () => {
  it("passes Adobe's catalog-entry validation; ports match the worker", () => {
    const { entry, errors, pending } = checkEntry(entryPath)
    expect(errors).toEqual([])
    expect(pending).toBe(true) // endpoints are filled in after deploy
    expect(entry.inputs.map((p: any) => p.name).sort()).toEqual([PORTS.background, PORTS.palette, PORTS.textLayout].sort())
    expect(entry.inputs.filter((p: any) => p.required).map((p: any) => p.name).sort()).toEqual([...REQUIRED_INPUTS].sort())
    expect(entry.outputs.map((p: any) => p.name)).toEqual([PORTS.colorDecision, PORTS.readability])
    expect(entry.customActionConfig.authentication).toEqual({ type: 'ims_service_token' })
  })
})
