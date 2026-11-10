// Image Extension — FFCPE web action: POST /submit, GET /status.
// IMS inbound auth (Authorization + x-api-key) is the SDK default; the catalog
// entry declares authentication "ims_service_token" to match.
import { Hono } from 'hono'
import { ToOpenWhiskAction } from 'hono-openwhisk-adapter'
import { mountFfcpeNodeRoutes } from '@adobe/ffcpe-custom-node-app-builder'

const app = new Hono()

mountFfcpeNodeRoutes(app, {
  worker: { package: 'territory-ffcpe-nodes', name: 'image-extension-worker' },
  web: { package: 'territory-ffcpe-nodes', name: 'image-extension-web' },
  loggerName: 'image-extension-web',
})

export const main = ToOpenWhiskAction(app)
