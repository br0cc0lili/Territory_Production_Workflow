// Offline harness that runs a node through Adobe's FFCPE Custom Node SDK
// exactly as App Builder would — real mountFfcpeNodeRoutes (POST /submit,
// GET /status, IMS inbound auth) and real createFfcpeNodeWorker — with the
// two platform services swapped for in-memory test doubles:
//   JobStore      (aio-lib-state)      -> Map
//   orchestrator  (OpenWhisk invoke)   -> calls the worker main() directly
// IMS token validation is replaced by a fake validator (no network).
import { Hono } from 'hono'
import {
  createImsInboundAuth,
  jobOrchestratorFromFn,
  type FfcpeNodeWorkerHandler,
  type JobRecord,
  type JobStore,
  type SubmitJobRequest,
} from '@adobe/ffcpe-custom-node-core'
import { createFfcpeNodeWorker, mountFfcpeNodeRoutes } from '@adobe/ffcpe-custom-node-app-builder'

export const TEST_TOKEN = 'test-ims-token'
export const TEST_API_KEY = 'run-workflow-service'

export function memoryJobStore(): JobStore & { records: Map<string, JobRecord> } {
  const records = new Map<string, JobRecord>()
  const update = (jobId: string, patch: Partial<JobRecord>) => {
    const cur = records.get(jobId)
    if (!cur) throw new Error(`Job ${jobId} not found`)
    // JSON round trip: aio-lib-state stores the record as a JSON string
    records.set(jobId, JSON.parse(JSON.stringify({ ...cur, ...patch, updatedAt: new Date().toISOString() })))
  }
  return {
    records,
    async create(jobId, metadata) {
      const now = new Date().toISOString()
      records.set(jobId, { jobId, status: 'processing', createdAt: now, updatedAt: now, metadata })
    },
    async get(jobId) {
      return records.get(jobId) ?? null
    },
    async complete(jobId, outputs) {
      update(jobId, { status: 'completed', outputs })
    },
    async fail(jobId, error) {
      update(jobId, { status: 'failed', error })
    },
  }
}

export interface SdkRunOptions {
  handler: FfcpeNodeWorkerHandler
  requiredInputNames?: string[]
  submit: SubmitJobRequest
  token?: string | null
  webName?: string
  workerName?: string
  /** extra top-level worker args, as App Builder injects them (e.g. __ims_oauth_s2s) */
  workerArgs?: Record<string, unknown>
  /** configure the Hono app before the SDK routes are mounted (e.g. restrictCallers) */
  beforeMount?: (app: Hono) => void
  /** x-api-key sent by the simulated caller (default: run-workflow-service) */
  apiKey?: string
}

export async function runThroughSdk(opts: SdkRunOptions) {
  const jobStore = memoryJobStore()
  const worker = createFfcpeNodeWorker(opts.handler, {
    jobStore,
    requiredInputNames: opts.requiredInputNames,
  })
  const app = new Hono()
  opts.beforeMount?.(app)
  mountFfcpeNodeRoutes(app, {
    worker: { package: 'territory-ffcpe-nodes', name: opts.workerName ?? 'test-worker' },
    web: { package: 'territory-ffcpe-nodes', name: opts.webName ?? 'test-web' },
    jobStore,
    orchestrator: jobOrchestratorFromFn(async (payload) => {
      await worker({ ...opts.workerArgs, ...payload, LOG_LEVEL: 'error' })
    }),
    authenticate: createImsInboundAuth({
      validateToken: async (token, clientId) =>
        token === TEST_TOKEN ? { valid: true, clientId, orgId: 'TEST_ORG@AdobeOrg' } : { valid: false, reason: 'invalid token' },
    }),
  })
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'x-api-key': opts.apiKey ?? TEST_API_KEY }
  const token = opts.token === undefined ? TEST_TOKEN : opts.token
  if (token) headers.Authorization = `Bearer ${token}`

  const submitRes = await app.request('/submit', { method: 'POST', headers, body: JSON.stringify(opts.submit) })
  const submitBody = (await submitRes.json()) as Record<string, any>
  if (submitRes.status !== 202) return { submitRes, submitBody, statusRes: null, status: null, jobStore }

  const statusUrl = new URL(submitBody.statusUrl)
  const statusRes = await app.request(`/status${statusUrl.search}`, { method: 'GET', headers })
  const status = (await statusRes.json()) as Record<string, any>
  return { submitRes, submitBody, statusRes, status, jobStore }
}
