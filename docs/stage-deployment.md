# Stage deployment and registration — runbook

Status: **prepared, not executed.** Nothing has been deployed or registered.
Every step marked 🔑 needs Adobe credentials or permissions.

## What is already done and verified offline

| Item | Evidence |
|---|---|
| Both nodes on `integration/workflow-nodes` | merge of `feature/color-detection` + `feature/image-extension` |
| Tests | `npm test` — Color Detection 24, Image Extension 20, shared 8, integration 9 |
| Types | `npm run typecheck` |
| Catalog entries | `npm run validate:catalog` (Adobe's own validator, vendored) |
| Official build | `aio app build` → 4 action zips, each exports `main` (no login needed) |
| Stage catalog entries | `npm run catalog:stage -- --namespace <ns>` → `build/catalog/stage/*.entry.json`, validated |

## Registration requirements (from Adobe's SDK + CLI plugin source)

- **Catalog API**: `https://run-workflow.adobe.io`, `POST /catalog/actions`
  (the CLI plugin's `register`); org-scoped: entries are visible to the
  **whole org's** Workflow Builder (`GET /catalog/actions` returns Adobe's
  built-ins plus the caller org's custom actions). There is **no separate
  stage catalog** — hence the `-stage` actionTypes below.
- **Who registers**: an Adobe user signed in with `aio login`, with an
  **enterprise org** selected (`aio console org select`); the CLI sends the
  user token, `x-gw-ims-org-id` and `x-gw-ims-user-id`. The org must have
  Firefly Creative Production (Workflow Builder) — the API answers 403 if the
  user isn't a member of the org. Whether registering custom actions needs a
  specific admin role is not documented → confirm with the Adobe contact.
- **Composite key**: (org, actionType, version). Re-registering the same key
  → use `aio ffcpe catalog update <actionType> -f …`.
- **Entry rules** (all pass): kebab-case `actionType`, semver `version`,
  `handlerType: custom-action`, HTTPS `submitEndpoint` / `statusEndpoint`,
  ≥ 1 input and output port with unique names, `relatedActions`,
  `usage.commonPatterns`, `usage.bestPractices`; no `orgId` in the body.
- **Auth between run-workflow and our actions**: catalog
  `authentication: { "type": "ims_service_token" }` ↔ SDK IMS inbound auth;
  run-workflow sends `x-api-key: run-workflow-service` + an IMS service token.
- **Tooling**: `@adobe/aio-cli` (installed: 11.2.0) + `aio plugins:install
  @adobe/aio-cli-plugin-ffcpe` (npm package exists; its version label is 0.0.0).

## Steps

1. 🔑 **New Developer Console project** in the Territory org (alphanumeric,
   ≤ 20 chars, e.g. `TerritoryFfcpeNodes`) — Stage workspace is created with it.
   Do **not** reuse "Territory Automation": your global `aio` context currently
   points there (`aio where`), and deploying this app into that workspace
   would share its Runtime namespace with territory-app.
2. 🔑 Stage workspace → **add Firefly Services API** with an **OAuth
   Server-to-Server** credential (scopes incl. `firefly_api`, `ff_apis`) —
   needed only by Image Extension (Color Detection calls no Adobe API).
   Needs a Console admin / developer with Firefly Services entitlement.
3. 🔑 In `integration` checkout: `aio console workspace download <file>.json`,
   then `aio app use <file>.json --overwrite --no-input` (writes `.aio` /
   `.env`; both git-ignored; the JSON contains secrets — keep it out of git).
   Optionally copy `.env.example` values into `.env`.
4. 🔑 `aio app deploy` (Stage). Note the namespace in the printed web URLs:
   `https://<namespace>.adobeioruntime.net/api/v1/web/territory-ffcpe-nodes/<node>-web`.
5. `npm run catalog:stage -- --namespace <namespace>` → two Stage entries
   (`territory-color-detection-stage`, `territory-image-extension-stage`,
   names "(Stage)", deployed endpoints).
6. 🔑 `aio plugins:install @adobe/aio-cli-plugin-ffcpe`, `aio login`,
   `aio console org select` (the Territory org), then
   `aio ffcpe catalog validate --strict -f build/catalog/stage/<entry>` and
   `aio ffcpe catalog register --strict -f …` — Color Detection first.
   `aio ffcpe catalog list` should then show both.
7. 🔑 Workflow Builder (Stage test workflow):
   - **Color Detection**: Input Image (background render) + Input Text
     (textLayout JSON, palette JSON — see "JSON inputs" below) → node →
     Output Text. Expect `readability` text + `colorDecision`.
   - **Image Extension**: Input Image (source) + Input Text (layout JSON) →
     node → Output Image. Run once with **one** target, then with **three**
     targets and check how the Output Image node / generation history
     receives three images on `extendedImages` (see "Multiple image outputs").
8. Clean-up options: `aio ffcpe catalog disable <type>` hides an entry;
   `delete` removes it.

## Findings from the first Stage deployment (Color Detection, 2026-11-10)

Project **Territory Production Workflow** (`798FuchsiaTarsier`), Stage,
namespace `44531-798fuchsiatarsier-stage`, deployed from branch
`stage/color-detection` (manifest = Color Detection only). Details and the
Workflow Builder test: `test/stage/color-detection/README.md` on that branch.

1. **statusUrl** — the SDK built it from Runtime's internal controller host
   (not reachable outside Adobe). Fixed: `actions/shared/public-status-url.ts`
   rewrites it to the public web-action URL (= catalog `statusEndpoint`).
2. **Catalog access** — `aio ffcpe catalog list` (read-only) is refused for
   the account logged in to `aio`: "Caller is not associated with an Adobe
   org; Firefly Services requires an entitled enterprise org", also with
   `--org-id`. Registration needs an account that is a member of the
   Territory org **with Firefly Creative Production entitlement** — to be
   confirmed / granted by the org admin. Naming conflicts can only be
   checked then (`aio ffcpe catalog inspect territory-color-detection-stage`
   → 404 means free).
3. **App Builder Files from outside Runtime** — local uploads to the
   workspace's file storage are refused (ERROR_BAD_CREDENTIALS); inside
   Runtime (Image Extension's worker) it is the normal path.
4. **aio context** — use the deploy checkout's local `.aio` (`aio app use
   <workspace json>`); the global `aio` selection can stay on another project.
5. Runtime shows `app error` for status polls of failed jobs: the SDK answers
   HTTP 500 for `failed` (documented contract), not a fault.

## Open points to test on Stage (cannot be verified offline)

1. **JSON inputs from the canvas**: Workflow Builder's input nodes are Input
   Image / Text / Video; there is no documented "Input JSON". The SDK reads a
   `json` port also from a **text** item containing JSON (`getJsonInput`) —
   verified on Stage — but whether the canvas lets an Input Text node
   connect to a `json`-typed port is still open. If not, the ports' catalog
   `type` would need to become `text` (code unchanged).
2. **Multiple image outputs** — see below.
3. **IMS service token**: that run-workflow's calls pass the SDK's IMS check
   and the caller guard (`x-api-key: run-workflow-service`). If Stage shows
   403 "Caller not allowed", read the caller id from the web action logs and
   set `ALLOWED_CALLER_CLIENT_IDS`.
4. **Timeouts**: Image Extension catalog `timeoutMs` 600 000 / worker 10 min;
   Firefly per master 4 min.

## Multiple image outputs — what is known

| Source | Says |
|---|---|
| SDK contract | `outputs[]` is an array; items carry `port`; nothing limits one item per port. Verified: the real SDK routes return 3 items on `extendedImages` unchanged. |
| Workflow API spec (`AdobeDocs/ffs-workflow-builder-api`) | Input nodes take `content: [ … ]` — "one or more image (or binary) inputs" **per execution**; execution results have `outputs: array`. `CatalogPort` has no cardinality field. |
| Help: "Use input and output nodes" | "Multi-asset inputs are supported where the node catalog allows batch or list inputs." Output nodes receive the files; all files of a run are in generation history. |
| Not documented anywhere public | Whether a **downstream processing node** gets a multi-item port as one call with a list or one call per item (fan-out). |

Consequences built into `integration/workflow-nodes`:
- Image Extension keeps one image per target on one port (named
  `<target id>.png`, matched to `extensionMetadata.targets[].output.name`).
- Both workers **refuse** several items on a single-item port (e.g. 2
  backgrounds) with a clear error instead of silently using the first one
  (the SDK's `getImageInput` returns only the first match).
- Safe chaining today: **one layout per Image Extension job** when its
  output feeds Color Detection; several layouts per job (shared master) when
  the images go to an output node. If Stage shows fan-out, multi-layout jobs
  can feed Color Detection directly (then the textLayout must be per layout —
  to be designed with the upstream nodes).
