# Color Detection node (`territory-color-detection`)

Chooses, per text role, the approved palette colour that stays most readable
on the final composition — the plugin's **weakest-zone** Auto Text Color
logic, as an FFCPE custom node. No Adobe API call (pure computation in the
worker).

| | |
|---|---|
| Actions | `territory-ffcpe-nodes/color-detection-web` (submit/status), `…/color-detection-worker` |
| Catalog entry | `actions/color-detection/color-detection.entry.json` |
| Logic | `src/nodes/color-detection/detect.js` → `src/core/textcolor.js`, `src/core/palette.js` (reused from the plugin @ c19c056) |

## Inputs

| Port | Type | Required | Content |
|---|---|---|---|
| `background` | image (PNG/JPEG/WebP, HTTPS URL) | yes | The layout rendered **without the text being coloured** (Headline/Subline hidden) but with everything else — image, extension, overlays. A render that still shows the text would score the text's own pixels. |
| `textLayout` | json | yes | Text roles and their glyph line boxes (below). |
| `palette` | json | yes | The client's approved colours (below). |

### `textLayout`

```json
{
  "coordinateSpace": { "unit": "pt", "pageBounds": [0, 0, 1080, 1080] },
  "roles": [
    { "role": "headline", "fontSizePt": 87, "lines": [[80, 60, 170, 700], [175, 60, 265, 560]] },
    { "role": "subline",  "fontSizePt": 37, "lines": [[900, 60, 945, 620]] }
  ]
}
```

- Boxes are `[top, left, bottom, right]`.
- `coordinateSpace`: `{ "unit": "px" }` (default) = background-image pixels;
  `{ "unit": "pt", "pageBounds": [...] }` = page coordinates (e.g. InDesign
  points), mapped onto the render, which must show exactly `pageBounds`.
- `lines`: **one box per glyph line** (preferred — this is what the plugin's
  `roleLineBoxes` produces). `frame` is accepted as a fallback (whole text
  frame; a warning is added because empty frame areas then count as text).
- `fontSizePt` decides the threshold: ≥ 18 pt → 3:1, otherwise 4.5:1.
  Missing → 4.5:1 + warning.
- Limits: 10 roles, 50 lines per role. Role names: letters, digits, space, `_`, `-`.

### `palette`

```json
{
  "swatches": [
    { "id": "Audi/White RGB", "name": "White RGB", "model": "RGB", "values": [1, 1, 1] },
    { "id": "Audi/Audi Red",  "name": "Audi Red",  "rgb": [187, 10, 48] },
    { "id": "Audi/Silver",    "name": "Silver",    "hex": "#b3b3b3" }
  ],
  "selectedIds": ["Audi/White RGB", "Audi/Audi Red"]
}
```

- Each swatch: `model` + `values` in Adobe Swatch Exchange conventions
  (`RGB`/`CMYK`/`Gray` 0–1, `LAB` L 0–1 + a/b), or `rgb` (0–255), or `hex`.
  The original model/values are returned unchanged with the decision (so a
  CMYK print colour can be applied as CMYK); `rgb`/`hex` are the sRGB
  approximation used for contrast.
- `selectedIds` (optional): only these are candidates — the node never picks
  a colour outside them. Omitted = all swatches.
- Or an ASE file: `{ "aseUrl": "https://…/palette.ase", "selectedIds": [...] }`
  (ids are `Group/Name`, as in the plugin).

## Parameters

| Name | Default | |
|---|---|---|
| `largeTextThreshold` | 3 | minimum contrast for large text |
| `normalTextThreshold` | 4.5 | minimum contrast for normal text |
| `largeTextFromPt` | 18 | large-text size limit (pt) |

## Scoring (unchanged from the plugin)

Per role, over its own lines only: each line is cut into
`n = clamp(round(width / (2 × height)), 1, 12)` zones;
`zoneP10` = 10th percentile of the WCAG contrast between the colour and each
background pixel of the zone; `score = min(overall P10, weakest zoneP10)`.
Best score wins (ties: overall P10, then mean). The best colour is always
returned; below the threshold the role is **LOW**.

## Outputs

| Port | Type | Content |
|---|---|---|
| `colorDecision` | json | decision (below) |
| `readability` | text | `ok` — every role meets its threshold; `review` — at least one role is LOW or NO_DATA |

```json
{
  "status": "review",
  "roles": [{
    "role": "headline", "fontSizePt": 87, "threshold": 3, "source": "lines", "lines": 2, "zones": 7,
    "readability": "LOW", "readable": false,
    "color": { "id": "Audi/Audi Red", "name": "Audi Red", "model": "RGB", "values": [0.7333, 0.0392, 0.1882], "rgb": [187, 10, 48], "hex": "#bb0a30" },
    "contrast": { "weakestZone": 2.79, "overallP10": 2.79, "mean": 3.03 },
    "weakest": { "line": 0, "zone": 0, "p10": 2.79 },
    "ranking": [
      { "id": "Audi/Audi Red",       "name": "Audi Red",       "hex": "#bb0a30", "weakestZone": 2.79, "overallP10": 2.79,  "mean": 3.03 },
      { "id": "Audi/White RGB",      "name": "White RGB",      "hex": "#ffffff", "weakestZone": 1.16, "overallP10": 18.28, "mean": 16.8 },
      { "id": "Audi/Audi Black RGB", "name": "Audi Black RGB", "hex": "#000000", "weakestZone": 1.15, "overallP10": 1.15,  "mean": 2.62 }
    ],
    "warning": "low text contrast — headline Audi Red reaches 2.79:1 in its weakest part (needs 3:1); best of the selected colours"
  }, { "role": "subline", "readability": "OK", "color": { "name": "Audi Black RGB" }, "contrast": { "weakestZone": 17.62 } }],
  "warnings": ["low text contrast — headline Audi Red reaches 2.79:1 …"],
  "summary": "headline Audi Red 2.79:1 LOW (< 3:1) | subline Audi Black RGB 17.62:1",
  "scoring": { "method": "weakest-zone", "percentile": 0.1, "zones": { "maxPerLine": 12, "widthPerHeight": 2, "minPixels": 12 }, "thresholds": { "large": 3, "normal": 4.5, "largeFromPt": 18 } },
  "background": { "width": 540, "height": 540 },
  "candidates": 3
}
```

`readability` per role: `OK` | `LOW` (best approved colour, below threshold) |
`NO_DATA` (text area outside the render — no colour chosen). The values above
are the actual result for the mock submission (subline shortened). Note White
RGB: an overall P10 of 18.28:1 but 1.16:1 over the bright patch — exactly the
case the weakest-zone score exists for.

## Errors (job `failed`)

Missing port (`Missing required input: palette`), non-HTTPS or unreachable
URL (`background: URL must use HTTPS`, `background: download failed (HTTP 404)`),
malformed JSON field (message names the field), unknown `selectedIds`,
undecodable image (`Color Detection failed: …`). Low contrast is **not** a
failure — the job completes with `status: "review"`.

## What the upstream workflow must provide

Until the Data Merge / Subject Placement nodes exist, tests use
`test/fixtures/color-detection/mock-submission.json`. In the full workflow:

1. **A background-only render per layout** — after Data Merge, Subject
   Placement and Image Extension, with the coloured text hidden. In the
   InDesign flow this is the plugin's "page behind the text" JPG export; in a
   Workflow-native flow it must come from the render/compositing step.
2. **Glyph line boxes + font size per role** — from the layout engine that
   set the text (text fitting decides the line breaks, so this must come
   *after* text fit). InDesign: the plugin's `roleLineBoxes`.
3. **The approved palette** — client palette + the designer's selection.
4. **Applying the result** — writing `color` into the text (InDesign:
   `applyTextColor`; keep CMYK as CMYK) and routing `review` layouts to
   approval is the next node's job; this node only decides.

## Tests

`npm test` — `test/color-detection/`:
`core.test.ts` (the plugin's own regression cases on the copied core),
`detect.test.ts` (normalisation, per-role decisions, LOW/NO_DATA, errors),
`node.test.ts` (mock submission through the real SDK submit → worker → status,
ASE URL palette, failure messages, catalog entry vs. worker ports).
