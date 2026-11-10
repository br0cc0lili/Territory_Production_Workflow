// Image Extension — FFCPE worker (Adobe FFCPE Custom Node SDK adapter).
//
// Ports (must match image-extension.entry.json):
//   in  source             image  the original image (JPEG/PNG)
//   in  layout             json   { targets: [{ id, canvas: {width, height}, placement: {x, y, width, height} }] }
//   in  prompt             text   optional Firefly prompt for the generated areas
//   out extendedImages     image  one PNG per target that has an image, name "<target id>.png"
//   out extensionMetadata  json   per target: status, geometry, master / Firefly job, warnings
//
// Firefly credentials: the workspace OAuth Server-to-Server credential that
// App Builder injects (include-ims-credentials) — never from workflow inputs.
import {
  createImageOutput,
  createJsonOutput,
  getImageInput,
  getJsonInput,
  getTextInput,
  type FfcpeNodeWorkerHandler,
} from '@adobe/ffcpe-custom-node-core'
import { createFfcpeNodeWorker } from '@adobe/ffcpe-custom-node-app-builder'
import assets from '../../src/shared/assets.js'
import fireflyClient from '../../src/core/firefly-client.js'
import fireflyAuth from '../../src/core/firefly-auth.js'
import extend from '../../src/nodes/image-extension/extend.js'

export const PORTS = {
  source: 'source',
  layout: 'layout',
  prompt: 'prompt',
  extendedImages: 'extendedImages',
  extensionMetadata: 'extensionMetadata',
} as const
export const REQUIRED_INPUTS = [PORTS.source, PORTS.layout]

const MAX_SOURCE_BYTES = 80 * 1024 * 1024
const MAX_FIREFLY_OUTPUT_BYTES = 60 * 1024 * 1024

export interface ImageExtensionDeps {
  fetch?: typeof globalThis.fetch
  store?: { put(path: string, bytes: Buffer, contentType?: string): Promise<string> }
  /** Firefly client override (tests); default: territory-app client + injected workspace credential */
  firefly?: unknown
  authLib?: unknown
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  pollIntervalMs?: number
  timeoutMs?: number
}

const isKnown = (e: unknown) => Boolean(e && (e as { expose?: boolean }).expose)

export function createImageExtensionHandler(deps: ImageExtensionDeps = {}): FfcpeNodeWorkerHandler {
  const store = deps.store ?? assets.createFilesStore()
  return async ({ jobId, inputs, params, args, logger }) => {
    try {
      const sourceUrl = getImageInput(inputs, PORTS.source)
      if (!sourceUrl) return { status: 'failed', error: `Missing image on port "${PORTS.source}"` }
      const layout = getJsonInput(inputs, PORTS.layout)
      if (layout === undefined) return { status: 'failed', error: `Missing JSON on port "${PORTS.layout}"` }
      const prompt = getTextInput(inputs, PORTS.prompt)

      const sourceBytes = await assets.fetchAsset(sourceUrl, { fetch: deps.fetch, maxBytes: MAX_SOURCE_BYTES, what: PORTS.source })
      const getFirefly = async () => {
        if (deps.firefly) return deps.firefly
        const auth = fireflyAuth.getFireflyAuth(args, deps.authLib)
        return fireflyClient.createFireflyClient({ fetch: deps.fetch ?? globalThis.fetch, getAccessToken: auth.getAccessToken, clientId: auth.clientId })
      }
      const { images, metadata } = await extend.runImageExtension({
        sourceBytes,
        layout,
        prompt,
        params,
        deps: {
          getFirefly,
          fetchAsset: (url: string, o: object) => assets.fetchAsset(url, { ...o, fetch: deps.fetch, maxBytes: MAX_FIREFLY_OUTPUT_BYTES }),
          sleep: deps.sleep,
          now: deps.now,
          pollIntervalMs: deps.pollIntervalMs,
          timeoutMs: deps.timeoutMs,
        },
      })
      logger.info(`image extension ${metadata.status}: ${metadata.summary}; ${metadata.masters.length} Firefly generation(s)`)
      if (!images.length) {
        const reasons = metadata.targets.map((t: any) => `${t.id}: ${t.error || t.warnings.join('; ') || t.status}`)
        return { status: 'failed', error: `No extended image produced — ${reasons.join(' | ')}`.slice(0, 2000) }
      }

      const outputs = []
      for (const img of images) {
        const url = await store.put(`public/image-extension/${jobId}/${img.name}`, img.png, 'image/png')
        outputs.push(createImageOutput(url, { port: PORTS.extendedImages, name: img.name, mimeType: 'image/png' }))
      }
      outputs.push(createJsonOutput(metadata, { port: PORTS.extensionMetadata, name: 'extension-metadata.json' }))
      return { status: 'completed', outputs }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { status: 'failed', error: isKnown(error) ? message : `Image Extension failed: ${message}` }
    }
  }
}

export const main = createFfcpeNodeWorker(createImageExtensionHandler(), {
  requiredInputNames: REQUIRED_INPUTS,
  loggerName: 'image-extension-worker',
})
