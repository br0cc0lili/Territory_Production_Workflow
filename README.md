# Territory Production Workflow — FFCPE custom nodes

Custom nodes for **Adobe Firefly Creative Production for Enterprise (FFCPE)
Workflow Builder**, built with Adobe's official
[FFCPE Custom Node SDK](https://github.com/adobe/ffcpe-custom-node-sdk)
(`@adobe/ffcpe-custom-node-core` / `@adobe/ffcpe-custom-node-app-builder` 1.0.0)
on Adobe App Builder.

| Node | Branch | Purpose |
|---|---|---|
| Color Detection ([docs](docs/color-detection.md)) | `feature/color-detection` | Picks the most readable approved palette colour per text role (Headline / Subline) from a background-only render; flags LOW contrast for review. No Adobe API call. |
| Image Extension ([docs](docs/image-extension.md)) | `feature/image-extension` | Extends a source image to fill target layout canvases with Firefly Generative Expand, one shared master generation per job where possible, original pixels preserved. |

The processing logic is reused from the Territory InDesign plugin and the
`territory-app` backend, with everything InDesign/UXP-specific left out — the
nodes run on any workflow, not only the InDesign one.

## Layout

```
actions/<node>/<node>.web.ts       SDK web action: POST /submit, GET /status (IMS inbound auth)
actions/<node>/<node>.worker.ts    SDK worker: reads ports, calls the node logic, writes outputs
actions/<node>/<node>.entry.json   catalog entry for `aio ffcpe catalog register`
src/core/                          reused processing logic (plain CommonJS, no SDK / platform)
src/nodes/<node>/                  node logic: inputs -> result (no SDK, network, storage)
src/shared/                        asset fetch (HTTPS only) / output store / params / raster
test/                              offline tests, incl. a full SDK submit -> worker -> status run
scripts/validate-entries.mjs       Adobe's catalog-entry validation, run locally
docs/                              integration + per-node contracts
```

## Commands

```bash
npm install
npm test                 # offline unit + SDK round-trip tests (vitest)
npm run typecheck
npm run validate:catalog # Adobe's catalog-entry rules on actions/*/*.entry.json
npm run catalog:stage -- --namespace <ns>  # Stage catalog entries after deploy
```

The SDK declares `node >= 22`; App Builder runs the actions on `nodejs:22`.

## Status

Local only — **not deployed, not registered, not pushed**. See
[docs/integration.md](docs/integration.md) and the Stage runbook
[docs/stage-deployment.md](docs/stage-deployment.md).
