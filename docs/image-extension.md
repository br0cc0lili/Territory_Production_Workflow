# Image Extension node (`territory-image-extension`)

Extends one source image so it fills each target layout canvas, from the
**final** placement of the image on each canvas, with Firefly Generative
Expand. All targets of a job share as few Firefly generations as possible
(one **master** per job, normally), so the layouts match each other; the
original pixels are kept.

| | |
|---|---|
| Actions | `territory-ffcpe-nodes/image-extension-web` (submit/status), `…/image-extension-worker` (`include-ims-credentials`) |
| Catalog entry | `actions/image-extension/image-extension.entry.json` |
| Logic | `src/nodes/image-extension/{plan,generate,compose,extend}.js` |
| Reused | `src/core/extension-plan.js` (plugin `imageextension.js` @ c19c056, planning functions verbatim), `src/core/firefly-client.js` (territory-app `firefly.js` @ b67bcb2, unchanged), `src/core/firefly-auth.js` (territory-app `auth.js`, adapted) |

## Inputs

| Port | Type | Required | Content |
|---|---|---|---|
| `source` | image (JPEG/PNG, HTTPS URL) | yes | the original image |
| `layout` | json | yes | the targets (below) |
| `prompt` | text | no | Firefly prompt for the generated areas (≤ 1024 chars) |

### `layout`

```json
{
  "targets": [
    { "id": "square_1200x1200", "canvas": { "width": 1200, "height": 1200 },
      "placement": { "x": 0, "y": 0, "width": 1200, "height": 800 } }
  ]
}
```

- `canvas`: the target frame in **output pixels** (integers, ≤ 8000).
- `placement`: where the **whole source image** lies on that canvas after
  subject placement (canvas pixels, may be fractional, may reach beyond the
  canvas — that part is cropped, never "missing"). Scale = placement size /
  source size.
- `id`: 1–80 of `A–Z a–z 0–9 . _ -`, unique; it names the output image.
- Up to 50 targets per job. **Send all layouts of one image in one job** —
  shared masters only form within a job.

## Parameters

| Name | Default | |
|---|---|---|
| `batchMode` | `shared` | `shared`: fewest master generations (plugin "consistent"); `independent`: one per target |
| `maxExtensionRatio` | 0.5 | automatic limit: generated share of the source per axis |
| `allowLarge` | false | generate targets over the extension/resolution limit anyway (after a human decision) |
| `coverageTolerancePx` | 2 | gaps up to this per side are filled from the original edge, not Firefly |

## What happens (plugin logic)

1. Per target (`plan.js` → plugin code): uncovered sides =
   `detectImageUnderfill(canvas, placement)`; in source px
   (`convertExpansionToSourcePixels`); plan + working geometry
   (`createExtensionPlan` / `fitWorkingGeometry`: one scale factor, ≤ 1, canvas
   ≤ 2688 px per side); eligibility (`checkAutoExtensionEligibility`: extension
   ≤ `maxExtensionRatio`, Firefly working px ≥ output px). Status:
   `not_required` | planned | `needs_review` | `failed` (doesn't overlap).
2. Grouping (`groupIntoMasterPlans`): planned targets join one master — the
   per-side maximum of their gaps — unless the master would become
   ineligible; then a new master is started.
3. Per master (`generate.js`, ≤ 3 in parallel): source resized to the working
   size → `POST /v2/storage/image` → `POST /v3/images/expand-async`
   (`size`, `placement.inset`, `prompt`) → poll `GET /v3/status/{jobId}`
   (status URL built from the validated job id; 4 min timeout) → download →
   `checkGeneratedSize` (same size or uniform rescale).
4. Per target (`compose.js`): the full master image positioned with
   `computeExtensionCanvasBounds` (its original region on the placed
   original), the **original** pasted over it (replacing Firefly's copy),
   tolerance gaps edge-filled; the original region is then **verified pixel
   by pixel** (`originalPreserved`). Bit-identical to the source when the
   placement is 1:1 at whole pixels; otherwise the original is resampled once
   to its placement size.

Cross-job reuse of generations (the plugin's versioned asset store /
"Use Existing") is **postponed**: every job generates its own masters.

## Outputs

| Port | Type | Content |
|---|---|---|
| `extendedImages` | image (PNG) | **one item per target that has an image**, name `<target id>.png`, canvas size, presigned App Builder Files URL (5 h) |
| `extensionMetadata` | json | job + per-target metadata (below) — match images by `targets[].output.name` |

Several images on one port: the SDK stores and returns the worker's
`outputs[]` array unchanged, and a port can carry several items (Adobe's
`input-images` describes its port as "one or more images"). Verified offline
through the real SDK routes; how a **downstream** node iterates over several
items on one port is decided by run-workflow and must be confirmed on Stage.

```json
{
  "status": "partial",
  "summary": "4 targets: 2 extended, 1 not required, 1 needs review",
  "source": { "width": 300, "height": 200, "format": "png", "contentKey": "…16 hex…" },
  "options": { "batchMode": "shared", "maxExtensionRatio": 0.5, "allowLarge": false, "coverageTolerancePx": 2, "prompt": true },
  "masters": [{ "id": "EXT_…", "targets": ["square_300x260", "tall_240x240"], "status": "succeeded",
                "fireflyJobId": "urn:ff:jobs:…", "error": null,
                "working": { "scale": 1, "source": { "width": 300, "height": 200 }, "size": { "width": 300, "height": 280 }, "inset": { "top": 20, "right": 0, "bottom": 60, "left": 0 } },
                "generated": { "width": 300, "height": 280, "scale": 1, "note": null } }],
  "targets": [{
    "id": "square_300x260", "status": "extended",
    "canvas": { "width": 300, "height": 260 }, "placement": { "x": 0, "y": 0, "width": 300, "height": 200 },
    "missing": { "top": 0, "right": 0, "bottom": 60, "left": 0 },
    "extensionRatio": { "x": 0, "y": 0.3, "max": 0.3 },
    "masterId": "EXT_…", "fireflyJobId": "urn:ff:jobs:…",
    "output": { "name": "square_300x260.png", "width": 300, "height": 260, "mimeType": "image/png" },
    "originalRegion": { "x": 0, "y": 0, "width": 300, "height": 200 }, "originalScale": { "x": 1, "y": 1 },
    "originalPreserved": true, "extensionRegion": { "x": 0, "y": 0, "width": 300, "height": 260 },
    "warnings": [], "error": null
  }, "…"]
}
```

Target `status`: `extended` | `not_required` (already covered — image still
returned) | `needs_review` (over a limit; no image; `warnings` say why) |
`failed` (no image; `error`). Job: `completed` when every target has an image,
`partial` when some do; the job **fails** only when no image at all can be
produced (error lists each target's reason).

## Errors (job `failed`)

Missing port, non-HTTPS/unreachable source, not JPEG/PNG, malformed layout or
parameter (message names the field), prompt too long, every target failed /
needs review, Firefly credential missing or without `firefly_api`/`ff_apis`.

## Credentials

The worker uses the workspace's OAuth Server-to-Server credential that App
Builder injects (`include-ims-credentials: true` → `__ims_oauth_s2s`), via
`@adobe/aio-lib-core-auth` (token cached 5 min). Nothing from the workflow
can supply or override it (tested). Token and secret are never logged. No
credential is needed when no target needs generation.

## What the upstream workflow must provide

Tests use `test/fixtures/image-extension/mock-submission.json` until Data
Merge / Subject Placement exist. In the full workflow:

1. **Source image per job** — the asset Data Merge selected for the row (HTTPS URL).
2. **Final placement per layout** — from Subject Placement: canvas size in
   output px and the placed image rectangle. InDesign equivalent: frame
   bounds + graphic bounds in pt (1 pt = 1 px at 72 dpi), i.e.
   `placement = graphicBounds − frame origin`.
3. **One job per source image**, all its layouts together (shared masters).
4. **Downstream**: the layout/render step places `<id>.png` filling its
   canvas (it already contains the original at the given placement) — the
   InDesign plugin instead keeps the original and clips strips on the
   `extendImage` layer; that stays plugin-side. Colour detection runs after
   this, on the extended render. `needs_review` targets go to approval;
   approved ones are re-run with `allowLarge: true`.

## Tests

`npm test` — `test/image-extension/`: `plan.test.ts` (targets, shared vs
independent masters, limits, resolution, tolerance, validation; compositing:
bit-identical original, cropping, edge fill), `node.test.ts` (mock submission
through the real SDK with a mocked Firefly HTTP API: one shared master,
request body + headers, 3 images on one port + metadata, Firefly rescale,
failures / partial, timeout, credential isolation, catalog entry).
