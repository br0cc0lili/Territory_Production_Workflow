// Validates every co-located catalog entry (actions/<node>/<node>.entry.json)
// with Adobe's own catalog-entry rules — the same function
// `aio ffcpe catalog validate` runs (vendored from adobe/aio-cli-plugin-ffcpe
// @ 01885bc, Apache-2.0: scripts/vendor/validate-catalog-entry.mjs).
//
// Endpoints still holding the deploy placeholder are reported as pending (they
// can only be filled in after `aio app deploy`), not as errors.
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { validateCatalogEntry } from './vendor/validate-catalog-entry.mjs'

export const PLACEHOLDER_HOST = 'NAMESPACE.adobeioruntime.net'

export function findEntries(root = 'actions') {
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => join(root, d.name, `${d.name}.entry.json`))
    .filter((p) => existsSync(p))
}

export function checkEntry(path) {
  const entry = JSON.parse(readFileSync(path, 'utf8'))
  const errors = validateCatalogEntry(entry)
  const cfg = entry.customActionConfig || {}
  const pending = [cfg.submitEndpoint, cfg.statusEndpoint].some((u) => String(u).includes(PLACEHOLDER_HOST))
  return { path, entry, errors, pending }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const entries = findEntries()
  if (!entries.length) {
    console.log('No catalog entries yet (actions/<node>/<node>.entry.json).')
    process.exit(0)
  }
  let failed = 0
  for (const p of entries) {
    const r = checkEntry(p)
    if (r.errors.length) {
      failed++
      console.log(`FAIL ${p}`)
      for (const e of r.errors) console.log(`  - ${e}`)
    } else {
      console.log(`ok   ${p}${r.pending ? '  (endpoints: deploy placeholder — fill in after aio app deploy)' : ''}`)
    }
  }
  process.exit(failed ? 1 : 0)
}
