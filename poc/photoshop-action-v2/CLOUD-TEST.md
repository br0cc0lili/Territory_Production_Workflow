# Cloud test — "Photoshop action V2" node (Workflow Builder)

Node interface (from the UI, 2026-11-10): inputs **Input Image\***, **Script\***,
Fonts, **Assets**, **input[0]**; one output **Processed Image**
(Original / JPEG / PNG / PSD / TIFF). No JSON output port.

The Photoshop API underneath supports JSON outputs (`scriptOutputPattern` +
`application/json`), but this node does not expose them — results have to
come out **inside the processed image**. The scripts below therefore report
through the image itself:

| Channel | Survives | Read with |
|---|---|---|
| coloured bar + text layer | every format (visible) | your eyes |
| XMP caption `TCD1:{…}` (dc:description) | PNG / JPEG / PSD / TIFF if the platform keeps metadata | `decode-carrier.mjs` |
| full JSON in a pixel strip appended at the bottom | PNG / TIFF / PSD (lossless) | `decode-carrier.mjs` |
| PSD layer names `TCD <role>=<swatch> OK/LOW` | PSD | `decode-carrier.mjs`, Photoshop |
| `plugin-temp:/…json` | only if Workflow Builder surfaces script files (unlikely) | generation history |

## Run 1 — minimal: does the script run, which pixel method works?

Script: `dist/smoke.psjs` (= `src/smoke.js`, 4.6 KB, no Color Detection code).

1. New workflow → **Input Image** (any RGB image, e.g. the Marderabwehr
   1080 background) → node **Input Image**.
2. **Script**: connect the script — try an **Input Text** node with the
   contents of `smoke.js` pasted, or upload the `.psjs` file if the port
   accepts files.
3. **Assets**: connect an Input Image with `config.marderabwehr.png`
   (made by `make-config-png.mjs`; any small PNG works for this run).
4. **input[0]**: connect an Input Text with any short text, e.g. `hello`.
5. Output Formats: **PSD** (keeps layers + metadata). Add an Output Image node, run.

Read the result:
- **Green bar** = `imaging.getPixels` works in the cloud. **Blue** = only the
  RAW fallback works. **Red** = neither. No bar at all = the script failed
  early or didn't run (check the run's error message).
- The text layer / layer name lists `getPixels`, `raw`, and which
  placeholders were replaced — i.e. whether **Assets** or **input[0]** arrive
  as `__ADDITIONAL_CONTENTS_PATH_0/1__` (with file size) or as something else.
- `node poc/photoshop-action-v2/decode-carrier.mjs <downloaded file>` prints the
  XMP caption (if metadata survived).

## Run 2 — full Color Detection through the node

Script: `dist/node-probe.embedded.psjs` (44 KB: the Custom Node's detect.js
bundled; also contains the Marderabwehr config as a fallback, so it produces a
decision even if Assets doesn't map). Same wiring as Run 1, Assets =
`config.marderabwehr.png`, Output Formats **PNG** (strip + XMP) and once **PSD**.

Expected (same as the Custom Node): **headline White RGB 7.8:1 OK, subline
White RGB 6.68:1 OK**. The report says where the config came from
(`additional[0] (png text chunk)` = Assets works as a JSON carrier;
`embedded` = it didn't).

## If Assets can't carry the config

Assets is image-typed, so the config travels as a PNG (`make-config-png.mjs`):
JSON in an uncompressed iTXt chunk, read from the raw file bytes (no zlib in
the sandbox), and the same JSON encoded in the pixels as a fallback (the
script opens the PNG and decodes it) in case the platform re-encodes the
asset. Alternatives: input[0] (if it carries text into the script), or one
script per layout with the config embedded (`node-probe.embedded.psjs`).
