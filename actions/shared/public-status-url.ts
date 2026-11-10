// Public statusUrl in the submit response.
//
// The SDK builds statusUrl from process.env.__OW_API_HOST. Inside Adobe I/O
// Runtime that is an INTERNAL controller host (seen on Stage:
// controller-gw-…int.ethos651-prod-irl1.ethos.adobe.net), which is not
// reachable from outside Adobe's network — and run-workflow prefers
// statusUrl over the catalog statusEndpoint when it is present. This
// middleware rewrites statusUrl to the public web-action URL, i.e. exactly
// the catalog statusEndpoint + ?jobId=…:
//   https://<namespace>.adobeioruntime.net/api/v1/web/<package>/<action>/status?jobId=<id>
// __OW_API_HOST itself is left alone (the SDK's worker invoke uses it).
import type { Hono } from 'hono'

const NAMESPACE = /^[a-z0-9][a-z0-9-]{2,62}$/

export function publicStatusUrl(namespace: string, packageName: string, actionName: string, jobId: string, statusPath = '/status') {
  return `https://${namespace}.adobeioruntime.net/api/v1/web/${packageName}/${actionName}${statusPath}?jobId=${encodeURIComponent(jobId)}`
}

export function usePublicStatusUrl(app: Hono, opts: { packageName: string; actionName: string; submitPath?: string; statusPath?: string }): void {
  app.use(opts.submitPath ?? '/submit', async (c, next) => {
    await next()
    const namespace = process.env.__OW_NAMESPACE
    if (c.res.status !== 202 || !namespace || !NAMESPACE.test(namespace)) return
    const body = (await c.res.clone().json().catch(() => null)) as { jobId?: string; statusUrl?: string } | null
    if (!body || typeof body.jobId !== 'string') return
    body.statusUrl = publicStatusUrl(namespace, opts.packageName, opts.actionName, body.jobId, opts.statusPath)
    c.res = new Response(JSON.stringify(body), { status: 202, headers: { 'Content-Type': 'application/json' } })
  })
}
