# Integration — how these nodes plug into FFCPE Workflow Builder

Source of truth: Adobe's FFCPE Custom Node SDK (`adobe/ffcpe-custom-node-sdk`,
`docs/custom-action-requests.md`) and the catalog CLI plugin
(`adobe/aio-cli-plugin-ffcpe`).

## Runtime contract (custom action)

1. **Submit** — run-workflow `POST`s to the node's `submitEndpoint`:
   ```json
   { "inputs": [ { "port": "...", "type": "image|text|video|json", "name": "...", "mimeType": "...", "url|text|json": ... } ],
     "parameters": { ... } }
   ```
   Headers (catalog `authentication: ims_service_token`):
   `Authorization: Bearer <IMS service token>`, `x-api-key: run-workflow-service`.
   The web action validates the token with IMS (`createImsInboundAuth`),
   stores a job (aio-lib-state), invokes the worker asynchronously and answers
   `202 { jobId, status: "processing", statusUrl }`.
2. **Status** — run-workflow `GET`s `statusUrl` every `pollIntervalMs` until
   `completed` (`200`, with `outputs[]`) or `failed` (`500`, with `error`).
3. **Outputs** have the same shape as inputs. **Image outputs are HTTPS URLs**
   (here: presigned App Builder Files URLs, valid 5 h) — downstream nodes
   download them. JSON outputs are inline and are stored in the job record, so
   keep them small (aio-lib-state value limit).

Each node = two OpenWhisk actions in package `territory-ffcpe-nodes`:

| Action | Manifest | Role |
|---|---|---|
| `<node>-web` | `web: "raw"`, `require-adobe-auth: false` | Hono app + `mountFfcpeNodeRoutes` |
| `<node>-worker` | not web | `createFfcpeNodeWorker(handler)` |

`require-adobe-auth: false` is what the SDK requires: IMS validation happens
inside the SDK routes instead of the App Builder gateway.

## Ports and connections

In a workflow, `connections[]` wire `sourcePort` → `targetPort`; these must
equal the catalog `outputs[].name` / `inputs[].name`. A port may carry more
than one item (e.g. `input-images` → "one or more images"); the SDK passes the
`outputs[]` array through unchanged, several items may share one port.

## Security

- Inputs/parameters are untrusted: image URLs must be HTTPS (also after
  redirects), downloads are size-capped, JSON inputs are validated field by
  field; errors name the field, never echo URLs or tokens.
- No credentials in the repo: `.env`, `.aio` and Console workspace downloads
  are git-ignored. Firefly credentials (Image Extension) come from the
  workspace OAuth Server-to-Server credential injected by App Builder
  (`include-ims-credentials`), never from inputs.
- The InDesign plugin's `x-plugin-key` gate is **not** used here.

## Deploy + register (not done yet)

1. Adobe Developer Console: a **new** project for these nodes (alphanumeric,
   ≤ 20 chars), Stage workspace. Image Extension also needs **Firefly
   Services** + an OAuth Server-to-Server credential (scopes incl.
   `firefly_api`, `ff_apis`).
2. `aio app use <downloaded workspace json> --overwrite --no-input`
   (the downloaded file contains secrets — it is git-ignored).
3. `aio app deploy` → web action base URL
   `https://<namespace>.adobeioruntime.net/api/v1/web/territory-ffcpe-nodes/<node>-web`.
4. Put `{base}/submit` and `{base}/status` into `actions/<node>/<node>.entry.json`
   (they hold the placeholder host `NAMESPACE.adobeioruntime.net` until then).
5. `aio plugins:install @adobe/aio-cli-plugin-ffcpe`, `aio login`,
   `aio console org select`, then
   `aio ffcpe catalog validate -f …entry.json` and
   `aio ffcpe catalog register -f …entry.json`.
