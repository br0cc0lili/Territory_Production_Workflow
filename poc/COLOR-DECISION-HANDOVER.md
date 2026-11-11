# Color Decision: Photoshop action V2 → InDesign

Status 2026-11-11.

**Proven so far:**
- **Cloud:** the Photoshop action V2 probe ran in Workflow Builder (`imaging.getPixels` OK; config read from Assets).
- **Desktop:** the production carrier and the InDesign apply step work end to end in Photoshop 27.10 and InDesign 21.6.

**Still open:** whether Workflow Builder keeps the image metadata (Run 3 in `photoshop-action-v2/CLOUD-TEST.md`), and which InDesign node Workflow Builder offers.

## Production architecture

```
background-only render ─┐
config PNG (Assets) ────┴─► Photoshop action V2  [color-decision.psjs]
                              reads pixels (getPixels, RAW fallback) + config,
                              runs detect.js (same code as the Custom Node)
                              ▼
                          Processed Image = SAME pixels
                              + XMP  tcd:ColorDecision  (JSON)  tcd:Status
                              ▼
                          InDesign step  [apply-color-decision.idjs]
                              image placed in "<<MainImage>>" → Link.linkXmp
                              (fallback: XMP packet from the file bytes)
                              → swatches applied to "<<Headline>>" paragraphs
                              → INDD + color-decision-report.json
```

- **No visible changes.** There is no banner, layer, text or extra pixel row, and no existing metadata is overwritten. Verified: the PNG and TIFF outputs are bit-identical to the input.
- **One artefact.** The image that gets placed carries its own decision, so the decision can't be paired with the wrong image.
- **Plugin conventions are kept:**
  - frames are found by name (`<<Headline>>`, `<<MainImage>>`);
  - headline is the 1st non-empty paragraph and subline the 2nd;
  - a swatch becomes a document colour of the same name, and an existing colour with that name is reused;
  - the choice is recorded in the `posterBatch.textColor` label (v2), which the plugin's `pageWarnings()` already reads.
- **Statuses:**
  - **`ok`:** the colour is applied.
  - **`review`:** the best approved colour is still applied, and the low-contrast warning is reported (same behaviour as the plugin).
  - **`error`**, a missing decision, or a decision for a different config (`configId` ≠ `expectConfigId`): nothing is applied, the template colours stay, and the page is reported.
- **Failure modes:**
  - If detection fails, the image still passes through with `tcd:Status=error`.
  - If the decision can't be written into the image, the Photoshop script throws, so the node fails instead of emitting an image without a decision.

## Ways to hand over the JSON

| Route | Reliability | When |
|---|---|---|
| **XMP in the processed image** (`decision-xmp.js`) | Survives PNG / JPEG / PSD / TIFF (desktop, 12 of 12 files). InDesign reads it from the placed link. | **Default.** Still to confirm: that Workflow Builder keeps metadata in its output. |
| InDesign API `params.decision` (JSON) | Exact structured JSON. | When an orchestrator outside Workflow Builder (App Builder action) calls the InDesign API. It reads the XMP with the same codec, or calls Photoshop API v2 directly with `scriptOutputPattern` → `application/json`. |
| `params.decisionImage` (asset) | Same XMP, read from an asset file. | When the analysed image is not the image that gets placed. |
| Custom Node JSON port | Native JSON between nodes. | Unchanged fallback; blocked on org catalog permission. |

Rejected for production:
- the visible banner and text layer;
- the pixel strip (it changes the image size);
- PSD layer names;
- the `dc:description` caption (it would overwrite the client's caption);
- `plugin-temp:/…json` (the node doesn't expose it).

These stay only in the diagnostic `node-probe`.

## Open questions

1. **Does Workflow Builder keep XMP?** Run 3 answers this. If metadata is stripped, the fallbacks are an orchestrator calling Photoshop API v2 for a JSON output, or the Custom Node.
2. **Which InDesign node exists in Workflow Builder?**
   - Merge InDesign data can map text and images, but not colours.
   - If there is a script-capable InDesign node (an "InDesign action" counterpart to Photoshop action V2), `apply-color-decision.idjs` runs there, with the processed image as its asset.
   - Otherwise it runs as an InDesign API Custom Scripts capability, either from an App Builder orchestrator or later as a Custom Node.
   - Bundle: `indesign-apply/dist/apply-color-decision.zip`. It is not registered.
3. **What exactly is analysed versus placed?** The decision describes the image it was computed on, and `image.width/height` are recorded in it. If Workflow Builder renders a separate background-only page, pass that render's output as `decisionImage`.

## Files

- `photoshop-action-v2/src/production.js` → `dist/color-decision.psjs` (39 KB)
- `photoshop-action-v2/src/decision-xmp.js`: the codec, shared by Photoshop, InDesign and Node
- `photoshop-action-v2/test-data/config.{audi-core,light-greys,mid-greys}.json` and `expected-decision.*.json`; config PNGs in `dist/config.*.png`
- `indesign-apply/src/apply-core.js`, `capability.js` → `dist/capability/` and `dist/apply-color-decision.zip`
- `photoshop-action-v2/decode-carrier.mjs <file>`: prints the decision found in any output file
- Tests: `test/poc/color-decision.test.ts`, `test/poc/indesign-apply.test.ts`

---

## Update 2026-11-11 (2): Black/White, designer selection, InDesign nodes

### Audi Black + White

There are two configs, with swatches copied unchanged from the original ASE files:

| Config | Swatches |
|---|---|
| `config.black-white.json` | `Audi_Colour_Library_digital`: Audi Black RGB (0,0,0), White RGB (1,1,1) |
| `config.black-white-print.json` | `Audi_Colour_Library_print`: Audi Black CMYK (C40 K100), White CMYK (0,0,0,0) |

How it behaves:
- **Independent roles:** each role is scored on its own, as before. A test with a dark headline zone and a light subline zone gives headline White and subline Audi Black.
- **Marderabwehr result:** both roles pick White (7.8:1 and 6.68:1; Audi Black reaches only 1.05 and 1.23).
- **CMYK reaches InDesign unchanged:** Audi Black CMYK is created as CMYK 40/0/0/100.
- **Desktop Photoshop:** both configs carry the decision in PNG, JPEG, PSD and TIFF, and the PNG and TIFF pixels are bit-identical.
- **Cloud test:** Run 4 in `photoshop-action-v2/CLOUD-TEST.md`, checked with `verify-output.mjs`.

### Designer-selectable colours: findings

From Adobe's help pages (2026-11), Workflow Builder offers:
- **Input nodes:** Input Image, Input Text and Input Video.
- **Template nodes** (Merge InDesign data, Merge Photoshop data): expose fields from an uploaded template.
- **Capsules (beta):** a published run screen. It shows only the nodes and options the author picks, takes uploads, and lets users edit an input **CSV** in place ("Edit CSV": add or delete rows, test run).
- **No documented dropdown, checkbox or colour-picker input.** Catalog parameters are typed `string | number | boolean | object | array`.

Proposal (not implemented; it waits for Run 4 and Run 5):
1. **Build the whole approved palette into the script.** The build reads both ASE files: all swatches, original names, models and values. The textLayout of each template is built in the same way. Designers never produce config files.
2. **Each run supplies only a selection, as swatch IDs or names.** The script looks them up in the built-in palette, so a run input can select colours but never define one. If a name is unknown or nothing is selected, the decision is `error` and nothing is applied.
3. **The selection channel depends on Run 5**, in order of preference:
   - **A. Input Text → input[0]**, typed or edited in the Capsule, e.g. `Audi Black RGB, White RGB`.
   - **B. A palette CSV** listing every approved swatch with a `use` column. The designer ticks `yes`/`no` per run through the Capsule's Edit CSV. This keeps the whole palette visible.
   - **C. Fallback:** if neither text nor CSV reaches the script, use a small set of preset selections (e.g. Black/White, full palette) prepared once and chosen as the Assets file in the Capsule.

### InDesign nodes and integration: findings

- **Documented InDesign node:** only **Merge InDesign data** (Text and Data section). It takes a `.indd` with Data Merge `<<fields>>`; text fields and `@image` fields become ports. It cannot run scripts or set colours.
  - Photoshop has a script node (Photoshop actions); no InDesign counterpart is documented.
  - **Still to confirm:** search the node library for "InDesign".
- **Can our apply script run in a built-in node?** Not with the documented nodes.
- **What does work natively:** map the processed image (with its decision) into a Merge InDesign data `@image` field. The merged document then carries the image together with its decision.
- **Smallest supported integration: the InDesign API Custom Scripts capability.** The bundle is ready (`indesign-apply/dist/apply-color-decision.zip`).
  - The Stage workspace of "Territory Production Workflow" **already has the InDesign API - Firefly Services enabled**, so no new API is needed.
  - **Steps (none done yet):**
    1. Register the capability once on Stage.
    2. Per job, one execute call with assets = the merged INDD or the template, plus the processed image, and params `{ targetDocument, decisionImage, outputDocument }`. The response is the INDD plus `color-decision-report.json`.
    3. Caller: a small web action in the existing Stage App Builder app. When catalog registration is approved, expose the same action as a Custom Node ("Apply text colour (InDesign)") placed after Merge InDesign data or Photoshop action V2.
  - Use `decisionImage` here rather than relying on the link: the link of a cloud-merged document may not resolve in a later job.
