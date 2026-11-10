// Generates Stage catalog entries from the co-located entries once the app
// is deployed to a Stage workspace — writes build/catalog/stage/*.entry.json,
// never edits the source entries, never calls any API.
//
//   node scripts/prepare-stage-catalog.mjs --namespace <runtime-namespace>
//   e.g. --namespace 1234567-territoryffcpe-stage   (from `aio app deploy` output)
//
// Stage entries get their own actionType (suffix "-stage") and a "(Stage)"
// name: the run-workflow catalog is org-wide (there is no separate stage
// catalog), so a Stage registration must not take the actionType a
// production registration will use later.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { findEntries, checkEntry } from './validate-entries.mjs'
import { validateCatalogEntry } from './vendor/validate-catalog-entry.mjs'

export const PACKAGE = 'territory-ffcpe-nodes'
const NAMESPACE = /^[a-z0-9][a-z0-9-]{2,62}$/

/** @param {any} entry @param {{ namespace: string, suffix?: string, ownTypes?: string[] }} opts */
export function stageEntry(entry, { namespace, suffix = '-stage', ownTypes = [] }) {
  if (!NAMESPACE.test(namespace)) throw new Error(`invalid Runtime namespace "${namespace}" (lowercase, as printed by aio app deploy)`)
  const web = entry.customActionConfig.submitEndpoint.match(/\/api\/v1\/web\/[^/]+\/([^/]+)\/submit$/)
  if (!web) throw new Error(`${entry.actionType}: can't find the web action name in submitEndpoint`)
  const base = `https://${namespace}.adobeioruntime.net/api/v1/web/${PACKAGE}/${web[1]}`
  const rename = (t) => (ownTypes.includes(t) ? t + suffix : t)
  return {
    ...entry,
    actionType: entry.actionType + suffix,
    name: `${entry.name} (Stage)`,
    tags: [...entry.tags, 'stage'],
    aliases: [], // aliases stay with the production registration
    relatedActions: entry.relatedActions.map(rename),
    customActionConfig: { ...entry.customActionConfig, submitEndpoint: `${base}/submit`, statusEndpoint: `${base}/status` },
  }
}

/** @param {{ namespace: string, root?: string, outDir?: string, suffix?: string }} opts */
export function prepareStageCatalog({ namespace, root = 'actions', outDir = 'build/catalog/stage', suffix = '-stage' }) {
  const sources = findEntries(root).map((p) => checkEntry(p))
  const ownTypes = sources.map((s) => s.entry.actionType)
  mkdirSync(outDir, { recursive: true })
  return sources.map(({ path, entry }) => {
    const out = stageEntry(entry, { namespace, suffix, ownTypes })
    const errors = validateCatalogEntry(out)
    const file = join(outDir, `${out.actionType}.entry.json`)
    writeFileSync(file, JSON.stringify(out, null, 2) + '\n')
    return { source: path, file, actionType: out.actionType, errors }
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const i = process.argv.indexOf('--namespace')
  const namespace = i > 0 ? process.argv[i + 1] : ''
  if (!namespace) {
    console.error('usage: node scripts/prepare-stage-catalog.mjs --namespace <runtime-namespace>')
    process.exit(2)
  }
  let results
  try {
    results = prepareStageCatalog({ namespace })
  } catch (e) {
    console.error(e.message)
    process.exit(2)
  }
  let failed = 0
  for (const r of results) {
    if (r.errors.length) { failed++; console.log(`FAIL ${r.file}\n  - ${r.errors.join('\n  - ')}`) }
    else console.log(`ok   ${r.file}  (${r.actionType})`)
  }
  if (!failed) {
    console.log('\nNext (needs aio login + the FFCPE CLI plugin; registers in the org-wide catalog):')
    for (const r of results) console.log(`  aio ffcpe catalog validate --strict -f ${r.file}`)
    for (const r of results) console.log(`  aio ffcpe catalog register --strict -f ${r.file}`)
  }
  process.exit(failed ? 1 : 0)
}
