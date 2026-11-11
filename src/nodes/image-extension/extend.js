// Image Extension — the whole job (no SDK; asset I/O and Firefly injected).
//
//   runImageExtension({ sourceBytes, layout, prompt, params, deps })
//     -> { images: [{ targetId, png }], metadata }
//
//   deps.firefly      Firefly client (src/core/firefly-client.js) — only
//                     created when something actually needs generating
//   deps.fetchAsset   downloads Firefly outputs (HTTPS only)
//   deps.sleep/now    timers (tests)
//
// Job outcome (metadata.status):
//   "completed"  every target has an image (extended or not needed)
//   "partial"    some targets have an image, others failed / need review
//   "failed"     no target has an image (the worker then fails the job)

const crypto = require("crypto");
const { createPlanner } = require("../../core/extension-plan.js");
const { loadJimp } = require("../../shared/raster.js");
const { NodeInputError, readString } = require("../../shared/params.js");
const { readOptions, normalizeTargets, planJob } = require("./plan.js");
const { generateUnits } = require("./generate.js");
const { composeTarget } = require("./compose.js");

const MAX_PROMPT = 1024; // Firefly ExpandImageRequest.prompt maxLength (territory-app gate.js)
const SOURCE_FORMATS = ["jpeg", "png"]; // what the worker can decode (Firefly receives a PNG)

function describeSource(bytes) {
    const header = createPlanner().parseImageHeader(bytes);
    if (!header || !SOURCE_FORMATS.includes(header.format)) throw new NodeInputError("source: must be a JPEG or PNG image");
    return { key: crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 16), ...header };
}

async function runImageExtension({ sourceBytes, layout, prompt, params, deps }) {
    const options = readOptions(params);
    const promptText = readString({ prompt }, "prompt", { maxLength: MAX_PROMPT });
    const targets = normalizeTargets(layout);
    const source = describeSource(sourceBytes);
    const sourceImage = await loadJimp(sourceBytes);
    if (sourceImage.bitmap.width !== source.width || sourceImage.bitmap.height !== source.height) {
        throw new NodeInputError("source: header size doesn't match the decoded image");
    }

    const { planner, targets: records, units } = planJob({ source, targets, options });
    let results = [];
    if (units.length) {
        const firefly = await deps.getFirefly();
        results = await generateUnits(units, { firefly, planner, sourceImage, prompt: promptText && promptText.trim(), fetchAsset: deps.fetchAsset, sleep: deps.sleep, now: deps.now, pollIntervalMs: deps.pollIntervalMs, timeoutMs: deps.timeoutMs });
    }
    const unitByMaster = new Map(results.map((r) => [r.masterId, r]));

    const images = [];
    const out = [];
    for (const rec of records) {
        const unit = rec.masterId ? unitByMaster.get(rec.masterId) : null;
        const entry = {
            id: rec.id, status: rec.status, canvas: rec.canvas, placement: rec.placement, missing: rec.missing,
            extensionRatio: rec.plan ? rec.plan.ratio : null, masterId: rec.masterId,
            fireflyJobId: unit ? unit.fireflyJobId : null, output: null, originalRegion: null, warnings: rec.reasons.slice(), error: null,
        };
        if (rec.status === "planned") {
            if (unit && unit.status === "succeeded") entry.status = "extended";
            else { entry.status = "failed"; entry.error = `Firefly generation failed: ${unit ? unit.error : "no result"}`; }
        }
        if (rec.status === "failed") entry.error = rec.reasons.join("; ");
        if (entry.status === "extended" || entry.status === "not_required") {
            const c = composeTarget({ planner, target: rec, sourceImage, unit: entry.status === "extended" ? unit : null });
            if (!c.originalVerified) throw new Error(`target ${rec.id}: original pixels changed during compositing`);
            if (c.edgeFilledPx) entry.warnings.push(`${c.edgeFilledPx} px gap (≤ ${options.coverageTolerancePx} px per side) filled with the nearest original pixels instead of Firefly`);
            const name = `${rec.id}.png`;
            images.push({ targetId: rec.id, name, png: await c.image.getBuffer("image/png") });
            Object.assign(entry, {
                output: { name, width: rec.canvas.width, height: rec.canvas.height, mimeType: "image/png" },
                originalRegion: c.originalRegion, originalScale: c.originalScale, originalPreserved: c.originalVerified,
                extensionRegion: c.extensionRegion,
            });
        }
        out.push(entry);
    }

    const ok = out.filter((t) => t.output).length;
    const status = ok === out.length ? "completed" : ok ? "partial" : "failed";
    const metadata = {
        status,
        summary: summarize(out),
        source: { width: source.width, height: source.height, format: source.format, contentKey: source.key },
        options: { ...options, prompt: promptText ? true : false },
        masters: results.map((r) => ({
            id: r.masterId, targets: r.targetIds, status: r.status, fireflyJobId: r.fireflyJobId, error: r.error,
            working: { scale: r.working.scale, source: r.working.source, size: r.working.size, inset: r.working.inset },
            generated: r.generated,
        })),
        targets: out,
    };
    return { images, metadata };
}

function summarize(targets) {
    const n = (s) => targets.filter((t) => t.status === s).length;
    const parts = [["extended", n("extended")], ["not required", n("not_required")], ["needs review", n("needs_review")], ["failed", n("failed")]]
        .filter(([, c]) => c).map(([k, c]) => `${c} ${k}`);
    return `${targets.length} target${targets.length === 1 ? "" : "s"}: ${parts.join(", ")}`;
}

module.exports = { runImageExtension, describeSource, MAX_PROMPT };
