# PoC — Color Detection via Photoshop API v2 / "Photoshop Action v2" (UXP script)

Question: can the Color Detection logic run inside Workflow Builder's built-in
**Photoshop Action v2** node (Photoshop API v2 `/v2/execute-actions` with a
UXP script) instead of a registered Custom Node?

Branch `poc/photoshop-action-color-detection` (from `integration/workflow-nodes`).
The Custom Node code (`src/`, `actions/`) is **reused unchanged** — this folder
only adds a UXP entry script and a bundler. Nothing deployed or registered.

## What it is

```
src/entry.js   UXP script: active document = job input image (background render)
               config  ← additionalContents[0] JSON (__ADDITIONAL_CONTENTS_PATH_0__)
                         or embedded at build time
               pixels  ← imaging.getPixels (sRGB, 8 bit); fallback: save a copy as
                         Photoshop RAW to the temp folder and read the bytes
               scoring ← src/nodes/color-detection/detect.js (same as the Custom Node)
               output  → plugin-temp:/color-decision.json
build.mjs      esbuild → one self-contained script (≈ 30 KB; only requires
               photoshop / uxp / fs — the sandbox allow-list)
```

Config file (`additionalContents[0]`):
`{ "textLayout": {…same as the node's textLayout port…}, "palette": {…palette port…}, "options": {…thresholds…} }`

Photoshop API request (see `dist/execute-actions.request.json` after building, not sent):

```json
{
  "image": { "source": { "url": "<background-only render>" } },
  "options": {
    "additionalContents": [{ "source": { "url": "<config.json>" } }],
    "uxp": { "source": { "content": "<dist/color-detection.psjs>", "contentType": "application/javascript" } }
  },
  "outputs": [{ "mediaType": "application/json", "destination": { "validityPeriod": 3600 }, "scriptOutputPattern": "color-decision.json" }]
}
```

## Results (2026-11-10)

| Check | Result |
|---|---|
| Simulated execute-actions sandbox (Node vm: only photoshop/uxp/fs requireable, placeholder replaced like the API) — `test/poc/photoshop-action.test.ts` | 6/6: identical to the Custom Node for both pixel paths; config via additionalContents and embedded; errors returned as JSON |
| **Desktop Photoshop 2026 (27.10.0)**, Marderabwehr test data, `imaging.getPixels` | **identical** to the Custom Node: headline White RGB 7.8:1, subline White RGB 6.68:1 (pixels 455 ms, scoring 260 ms) |
| Desktop Photoshop, RAW-export fallback | **identical**; pixels 1232 ms |

## Not verifiable without the cloud / the node

1. **`imaging` in the cloud sandbox** — Adobe's allow-list describes
   `photoshop` as "Core Photoshop app, document, action, and batchPlay API";
   the imaging API is not mentioned. The RAW fallback uses only batchPlay +
   `uxp` storage (temp folder) — whether the temp folder / session token
   work in the cloud sandbox is also untested.
2. **The Workflow Builder node's interface** — not publicly documented, and
   `aio ffcpe catalog inspect` is blocked for our account (entitlement).
   Needed: does the node take the script inline / as a file, does it expose
   **additionalContents** (per-run text layout + palette from upstream nodes),
   and does it expose **JSON outputs** (`scriptOutputPattern`,
   `application/json`) or only images?

## Building / running

```bash
node poc/photoshop-action-v2/build.mjs                        # dist/*.psjs + request example
npx vitest run test/poc                                        # simulated sandbox
node poc/photoshop-action-v2/build.mjs --background <png> --out <json>   # + desktop harness
open -a "Adobe Photoshop 2026" poc/photoshop-action-v2/dist/color-detection.local-test.psjs
```

The desktop harness opens only the given background, runs the same bundle,
writes the JSON to `--out`, and closes only the document it opened.
`test-data/*.png` (client asset) and `dist/` are git-ignored.

## Production

`dist/color-decision.psjs` (`src/production.js`): the decision is written only as XMP, and the image stays unchanged. The InDesign side lives in `../indesign-apply/`. Architecture, hand-over options and open questions: `../COLOR-DECISION-HANDOVER.md`. Cloud test: Run 3 in `CLOUD-TEST.md`.
