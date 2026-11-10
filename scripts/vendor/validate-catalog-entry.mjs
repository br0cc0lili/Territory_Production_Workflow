/*
Copyright 2026 Adobe. All rights reserved.
This file is licensed to you under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License. You may obtain a copy
of the License at http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software distributed under
the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
OF ANY KIND, either express or implied. See the License for the specific language
governing permissions and limitations under the License.
*/

import semver from 'semver'

const ACTION_TYPE_RE = /^[a-z0-9-]+$/

/**
 * Validate a catalog entry object against rules enforced by the Catalog API and local schema.
 * @param {unknown} entry Parsed JSON object representing a custom action definition.
 * @returns {string[]} Human-readable validation errors; empty array when valid.
 */
export function validateCatalogEntry (entry) {
  const errors = []

  if (!entry || typeof entry !== 'object') {
    return ['Body must be a JSON object.']
  }

  /** @type {Record<string, unknown>} */
  const o = /** @type {Record<string, unknown>} */ (entry)

  if ('orgId' in o) {
    errors.push('Remove orgId from the catalog entry (resolved from auth headers).')
  }

  const actionType = o.actionType
  if (typeof actionType !== 'string' || !ACTION_TYPE_RE.test(actionType)) {
    errors.push(
      'actionType must be a non-empty kebab-case string matching /^[a-z0-9-]+$/.'
    )
  }

  const version = o.version
  if (typeof version !== 'string' || !semver.valid(version)) {
    errors.push('version must be a valid semver string.')
  }

  for (const field of ['name', 'description', 'category']) {
    if (typeof o[field] !== 'string' || !String(o[field]).trim()) {
      errors.push(`${field} must be a non-empty string.`)
    }
  }

  for (const field of ['disabled', 'workflowEnabled']) {
    if (typeof o[field] !== 'boolean') {
      errors.push(`${field} must be a boolean.`)
    }
  }

  if (!Array.isArray(o.aliases)) {
    errors.push('aliases must be an array.')
  }

  if (!Array.isArray(o.tags)) {
    errors.push('tags must be an array.')
  }

  const handlerType = o.handlerType
  if (handlerType !== 'custom-action') {
    errors.push('handlerType must be "custom-action".')
  }

  const inputs = o.inputs
  const outputs = o.outputs
  if (!Array.isArray(inputs) || inputs.length < 1) {
    errors.push('inputs must be a non-empty array.')
  }
  if (!Array.isArray(outputs) || outputs.length < 1) {
    errors.push('outputs must be a non-empty array.')
  }

  if (Array.isArray(inputs)) {
    const names = new Set()
    for (const p of inputs) {
      if (!p || typeof p !== 'object') {
        errors.push('Each input must be an object.')
        continue
      }
      const n = /** @type {{ name?: string }} */ (p).name
      if (typeof n !== 'string' || !n.trim()) {
        errors.push('Each input must have a name.')
      } else if (names.has(n)) {
        errors.push(`Duplicate input name: ${n}`)
      } else {
        names.add(n)
      }
    }
  }

  if (Array.isArray(outputs)) {
    const names = new Set()
    for (const p of outputs) {
      if (!p || typeof p !== 'object') {
        errors.push('Each output must be an object.')
        continue
      }
      const n = /** @type {{ name?: string }} */ (p).name
      if (typeof n !== 'string' || !n.trim()) {
        errors.push('Each output must have a name.')
      } else if (names.has(n)) {
        errors.push(`Duplicate output name: ${n}`)
      } else {
        names.add(n)
      }
    }
  }

  if (!Array.isArray(o.parameters)) {
    errors.push('parameters must be an array.')
  } else {
    const pnames = new Set()
    for (const p of o.parameters) {
      if (!p || typeof p !== 'object') {
        errors.push('Each parameter must be an object.')
        continue
      }
      const n = /** @type {{ name?: string }} */ (p).name
      if (typeof n !== 'string' || !n.trim()) {
        errors.push('Each parameter must have a name.')
      } else if (pnames.has(n)) {
        errors.push(`Duplicate parameter name: ${n}`)
      } else {
        pnames.add(n)
      }
    }
  }

  const related = o.relatedActions
  if (!Array.isArray(related) || related.length < 1) {
    errors.push('relatedActions must have at least one entry.')
  }

  const usage = o.usage
  if (!usage || typeof usage !== 'object') {
    errors.push('usage object is required.')
  } else {
    const u = /** @type {{ commonPatterns?: unknown, bestPractices?: unknown }} */ (usage)
    if (!Array.isArray(u.commonPatterns) || u.commonPatterns.length < 1) {
      errors.push('usage.commonPatterns must have at least one entry.')
    }
    if (!Array.isArray(u.bestPractices) || u.bestPractices.length < 1) {
      errors.push('usage.bestPractices must have at least one entry.')
    }
  }

  const cfg = o.customActionConfig
  if (!cfg || typeof cfg !== 'object') {
    errors.push('customActionConfig is required for custom-action.')
  } else {
    const c = /** @type {{ submitEndpoint?: unknown, statusEndpoint?: unknown }} */ (cfg)
    if (!isHttpsUrl(c.submitEndpoint)) {
      errors.push(
        'customActionConfig.submitEndpoint must be a valid https: URL.'
      )
    }
    if (!isHttpsUrl(c.statusEndpoint)) {
      errors.push(
        'customActionConfig.statusEndpoint must be a valid https: URL.'
      )
    }
  }

  return errors
}

/**
 * @param {unknown} v Value taken from customActionConfig endpoint fields.
 * @returns {boolean} True if v is a non-empty string whose URL uses the https scheme.
 */
function isHttpsUrl (v) {
  if (typeof v !== 'string' || !v.trim()) {
    return false
  }
  try {
    const u = new URL(v)
    return u.protocol === 'https:'
  } catch {
    return false
  }
}
