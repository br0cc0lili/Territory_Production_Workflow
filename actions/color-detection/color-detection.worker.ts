// Color Detection — FFCPE worker (Adobe FFCPE Custom Node SDK adapter).
//
// Ports (must match color-detection.entry.json):
//   in  background   image  background-only render (Headline/Subline hidden)
//   in  textLayout   json   text roles + glyph line boxes
//   in  palette      json   approved palette colours (or { aseUrl, selectedIds })
//   out colorDecision json  per role: colour, contrast scores, OK / LOW, warnings
//   out readability  text   "ok" | "review" — for routing in the workflow
//
// This file only maps ports <-> the node logic in src/nodes/color-detection.
import {
  createJsonOutput,
  createTextOutput,
  getImageInput,
  getJsonInput,
  type FfcpeNodeWorkerHandler,
} from '@adobe/ffcpe-custom-node-core'
import { createFfcpeNodeWorker } from '@adobe/ffcpe-custom-node-app-builder'
import assets from '../../src/shared/assets.js'
import raster from '../../src/shared/raster.js'
import detect from '../../src/nodes/color-detection/detect.js'

export const PORTS = {
  background: 'background',
  textLayout: 'textLayout',
  palette: 'palette',
  colorDecision: 'colorDecision',
  readability: 'readability',
} as const

const MAX_BACKGROUND_BYTES = 60 * 1024 * 1024
const MAX_ASE_BYTES = 2 * 1024 * 1024

export interface ColorDetectionDeps {
  fetch?: typeof globalThis.fetch
}

// NodeInputError / AssetError messages are safe to show; anything else is wrapped.
const isKnown = (e: unknown) => Boolean(e && (e as { expose?: boolean }).expose)

export function createColorDetectionHandler(deps: ColorDetectionDeps = {}): FfcpeNodeWorkerHandler {
  return async ({ inputs, params: workflowParams, logger }) => {
    try {
      const multi = [PORTS.background, PORTS.textLayout, PORTS.palette].find((port) => inputs.filter((i) => i.port === port).length > 1)
      if (multi) return { status: 'failed', error: `Port "${multi}" received ${inputs.filter((i) => i.port === multi).length} items; Color Detection takes one per job (one layout per job)` }
      const backgroundUrl = getImageInput(inputs, PORTS.background)
      if (!backgroundUrl) return { status: 'failed', error: `Missing image on port "${PORTS.background}"` }
      const layout = getJsonInput(inputs, PORTS.textLayout)
      if (layout === undefined) return { status: 'failed', error: `Missing JSON on port "${PORTS.textLayout}"` }
      let palette = getJsonInput<Record<string, unknown>>(inputs, PORTS.palette)
      if (palette === undefined) return { status: 'failed', error: `Missing JSON on port "${PORTS.palette}"` }

      if (palette && typeof palette === 'object' && typeof palette.aseUrl === 'string') {
        const ase = await assets.fetchAsset(palette.aseUrl, { fetch: deps.fetch, maxBytes: MAX_ASE_BYTES, what: 'palette.aseUrl' })
        palette = { ase: new Uint8Array(ase), selectedIds: palette.selectedIds }
      }

      const bytes = await assets.fetchAsset(backgroundUrl, { fetch: deps.fetch, maxBytes: MAX_BACKGROUND_BYTES, what: PORTS.background })
      const image = await raster.decodeImage(bytes)
      const result = detect.detectTextColors({ image, layout, palette, options: workflowParams })
      logger.info(`color detection: ${result.status} — ${result.summary}`)

      return {
        status: 'completed',
        outputs: [
          createJsonOutput(result, { port: PORTS.colorDecision, name: 'color-decision.json' }),
          createTextOutput(result.status, { port: PORTS.readability, name: 'readability.txt' }),
        ],
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { status: 'failed', error: isKnown(error) ? message : `Color Detection failed: ${message}` }
    }
  }
}

export const REQUIRED_INPUTS = [PORTS.background, PORTS.textLayout, PORTS.palette]

export const main = createFfcpeNodeWorker(createColorDetectionHandler(), {
  requiredInputNames: REQUIRED_INPUTS,
  loggerName: 'color-detection-worker',
})
