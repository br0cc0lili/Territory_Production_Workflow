// Color Detection — FFCPE web action: POST /submit, GET /status.
// IMS inbound auth (Authorization + x-api-key) is the SDK default; the catalog
// entry declares authentication "ims_service_token" to match. Callers are
// additionally limited to run-workflow's client id (caller-guard.ts).
import { Hono } from 'hono'
import { ToOpenWhiskAction } from 'hono-openwhisk-adapter'
import { mountFfcpeNodeRoutes } from '@adobe/ffcpe-custom-node-app-builder'
import { restrictCallers } from '../shared/caller-guard'
import { usePublicStatusUrl } from '../shared/public-status-url'

const app = new Hono()

// only Workflow Builder's run-workflow service may call (see actions/shared/caller-guard.ts)
restrictCallers(app)
// statusUrl → public URL (the SDK's points at Runtime's internal host; see public-status-url.ts)
usePublicStatusUrl(app, { packageName: 'territory-ffcpe-nodes', actionName: 'color-detection-web' })

mountFfcpeNodeRoutes(app, {
  worker: { package: 'territory-ffcpe-nodes', name: 'color-detection-worker' },
  web: { package: 'territory-ffcpe-nodes', name: 'color-detection-web' },
  loggerName: 'color-detection-web',
})

export const main = ToOpenWhiskAction(app)
