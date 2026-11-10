# Color Detection — Stage test (Workflow Builder)

Deployment: Adobe Developer Console project **Territory Production Workflow**
(`798FuchsiaTarsier`), workspace **Stage**, Runtime namespace
`44531-798fuchsiatarsier-stage`, branch `stage/color-detection`.

| | URL |
|---|---|
| Web action | `https://44531-798fuchsiatarsier-stage.adobeioruntime.net/api/v1/web/territory-ffcpe-nodes/color-detection-web` |
| submitEndpoint | `…/color-detection-web/submit` |
| statusEndpoint | `…/color-detection-web/status` |
| Worker (private) | `territory-ffcpe-nodes/color-detection-worker` |

Catalog entry (not registered): `build/catalog/stage/territory-color-detection-stage.entry.json`
— regenerate with
`npm run catalog:stage -- --namespace 44531-798fuchsiatarsier-stage --only color-detection`.

## Test inputs (this folder)

| File | Use |
|---|---|
| `assets/marderabwehr_background_1080.png` | background-only render stand-in: the Audi DANIS Marderabwehr image, centre-cropped to 1080 × 1080 (a 1080 pt page). **Git-ignored** (client asset). Source: `Territory-kickoff/01_Assets/Test_images/Audi_DANIS_Fruehling_Marderabwehr.png` |
| `textLayout.json` / `textLayout.min.txt` | headline (87 pt, 2 glyph lines) and subline (37 pt, 1 line) in page points, `pageBounds [0,0,1080,1080]` |
| `palette.json` / `palette.min.txt` | Audi digital library (`Audi_Colour_Library_digital.ase`): White RGB, Audi Black RGB, Audi Progressive Red RGB — all three approved |
| `expected-marderabwehr.json` | result of the same code locally: **ok — headline White RGB 7.8:1, subline White RGB 6.68:1** |

Paste the `.min.txt` contents (one line of JSON) into Input Text nodes.

## Workflow Builder steps (after registration)

1. Firefly → **Production** → **Create workflow** (in the Territory org).
2. Add nodes:
   - **Input Image** — upload `assets/marderabwehr_background_1080.png`.
   - **Input Text** #1 — paste `textLayout.min.txt`.
   - **Input Text** #2 — paste `palette.min.txt`.
   - **Territory Text Color Detection (Stage)** (category *custom*).
   - **Output Text** #1 and #2.
3. Connect: Input Image → `background`; Input Text #1 → `textLayout`;
   Input Text #2 → `palette`; `readability` → Output Text #1;
   `colorDecision` → Output Text #2.
4. Run. Expect `readability` = `ok` and in `colorDecision`:
   headline White RGB 7.8:1 OK, subline White RGB 6.68:1 OK
   (compare with `expected-marderabwehr.json`).
5. Review case: change the palette text so that `selectedIds` only contains
   `"Audi_Colour_Library_digital/Audi Progressive Red RGB"` → expect
   `readability` = `review`, both roles LOW with the warning text.

Things to note while testing (cannot be checked offline):
- Whether an **Input Text** node can connect to the `json`-typed ports
  `textLayout` / `palette`. The node accepts JSON sent as text (verified on
  Stage), but the canvas may not allow the connection. If it doesn't, the
  catalog port type can be changed to `text` (no code change).
- Whether `colorDecision` (json) can go into an **Output Text** node, or how
  the run's generation history shows it.
- The job should finish in ~6 s (Stage smoke test: 5.9–6.7 s incl. polling).

## Verified on Stage (2026-11-10)

- Deployed only `color-detection-web` + `color-detection-worker` (manifest of
  this branch contains nothing else); `nodejs:22`, web `raw`,
  `require-adobe-auth: false`, worker 1024 MB / 120 s.
- Auth: no headers → 401; other caller client id → 403 "Caller not allowed";
  `run-workflow-service` with an invalid token → 401 at the IMS check;
  worker URL without namespace credentials → 401.
- End to end (temporary test allow-list for this project's own Stage
  credential, removed afterwards): submit 202 → status 200 `completed`,
  outputs `colorDecision` (json) + `readability` (text); result
  **identical** to the local run; JSON inputs sent as **text** give the same
  result; a missing `palette` gives a `failed` job
  ("Missing required input: palette"). Test background for this smoke test:
  a public Adobe docs image (local uploads to the workspace's App Builder
  Files are refused outside Runtime).
- `statusUrl` now points at the public host (the SDK's default pointed at
  Runtime's internal controller host — fixed in `actions/shared/public-status-url.ts`).
- Activation logs: no tokens / secrets.
