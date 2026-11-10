// Caller allow-list for the FFCPE web actions (submit / status).
//
// Why: the SDK's default IMS inbound auth accepts ANY valid IMS access token
// whose client id equals the x-api-key header — i.e. anyone with an Adobe
// IMS token for their own integration could call these endpoints (and spend
// Firefly credits via Image Extension). Workflow Builder's run-workflow
// service calls custom actions with `x-api-key: run-workflow-service` and an
// IMS service token for that client (SDK docs/custom-action-requests.md), so
// only that client id is allowed by default. The SDK's own check then still
// validates the token itself against IMS for that client id.
//
// Override per deployment with the web action input ALLOWED_CALLER_CLIENT_IDS
// (comma-separated; app.config.yaml → .env). Empty / unset → the default.
import type { Hono } from 'hono'

export const DEFAULT_ALLOWED_CALLERS = ['run-workflow-service']

export function parseAllowList(value: unknown): string[] | null {
  if (typeof value !== 'string') return null
  const v = value.trim()
  if (!v || v.startsWith('$')) return null // unset / unresolved manifest variable
  const ids = v.split(',').map((s) => s.trim()).filter(Boolean)
  return ids.length ? ids : null
}

export function restrictCallers(app: Hono, opts: { allowed?: string[] } = {}): void {
  app.use('*', async (c, next) => {
    const env = c.env as { params?: Record<string, unknown> } | undefined
    const allowed = parseAllowList(env?.params?.ALLOWED_CALLER_CLIENT_IDS) ?? opts.allowed ?? DEFAULT_ALLOWED_CALLERS
    const apiKey = c.req.header('x-api-key')
    // missing header: let the SDK answer 401 "Missing required header(s)"
    if (apiKey && !allowed.includes(apiKey)) return c.json({ error: 'Caller not allowed' }, 403)
    await next()
  })
}
