// Stage catalog generation (scripts/prepare-stage-catalog.mjs) — offline, writes to a temp dir.
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { prepareStageCatalog, stageEntry } from '../../scripts/prepare-stage-catalog.mjs'

describe('prepare-stage-catalog', () => {
  it('writes valid Stage entries with their own actionType and the deployed endpoints; sources untouched', () => {
    const before = readFileSync('actions/color-detection/color-detection.entry.json', 'utf8')
    const outDir = mkdtempSync(join(tmpdir(), 'stage-catalog-'))
    const r = prepareStageCatalog({ namespace: '1234567-territoryffcpe-stage', outDir })
    expect(r.map((x: any) => [x.actionType, x.errors])).toEqual([
      ['territory-color-detection-stage', []],
      ['territory-image-extension-stage', []],
    ])
    const cd = JSON.parse(readFileSync(r[0].file, 'utf8'))
    expect(cd.customActionConfig.submitEndpoint).toBe('https://1234567-territoryffcpe-stage.adobeioruntime.net/api/v1/web/territory-ffcpe-nodes/color-detection-web/submit')
    expect(cd.customActionConfig.statusEndpoint).toBe('https://1234567-territoryffcpe-stage.adobeioruntime.net/api/v1/web/territory-ffcpe-nodes/color-detection-web/status')
    expect(cd.customActionConfig.authentication).toEqual({ type: 'ims_service_token' })
    expect(cd.relatedActions).toEqual(['input-images', 'territory-image-extension-stage'])
    expect(cd.name).toBe('Territory Text Color Detection (Stage)')
    expect(readFileSync('actions/color-detection/color-detection.entry.json', 'utf8')).toBe(before)
  })
  it('--only: just one node (for a deployment that contains only that node)', () => {
    const outDir = mkdtempSync(join(tmpdir(), 'stage-catalog-'))
    const r = prepareStageCatalog({ namespace: '44531-798fuchsiatarsier-stage', outDir, only: 'color-detection' })
    expect(r.map((x: any) => x.actionType)).toEqual(['territory-color-detection-stage'])
    expect(() => prepareStageCatalog({ namespace: '44531-798fuchsiatarsier-stage', outDir, only: 'nope' })).toThrow(/no catalog entry/)
  })
  it('rejects a malformed namespace', () => {
    const e = JSON.parse(readFileSync('actions/image-extension/image-extension.entry.json', 'utf8'))
    expect(() => stageEntry(e, { namespace: 'Bad_NS' })).toThrow(/invalid Runtime namespace/)
    expect(() => stageEntry(e, { namespace: 'evil.example.com/x' })).toThrow(/invalid Runtime namespace/)
  })
})
