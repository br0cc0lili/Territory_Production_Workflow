// Image Extension — planning (pure: no SDK, network, storage or InDesign).
//
// From the FINAL placement of the source image on each target canvas (what
// Subject Placement decided), works out per target what is uncovered and
// what Firefly would have to generate, then groups the targets into as few
// MASTER generations as possible (normally one per job) — the plugin's
// "consistent" batch mode. Everything geometric is the plugin's code
// (src/core/extension-plan.js); this file only maps node inputs onto it.
//
//   readOptions(params)                     workflow parameters -> options
//   normalizeTargets(layout)                layout JSON -> targets
//   planJob({ source, targets, options })   -> { planner, targets: [record], units: [{ master, targetIds }] }
//
// Coordinates: target canvas pixels, origin top-left. placement = where the
// whole source image lies on the canvas ({ x, y, width, height }, may reach
// beyond the canvas — it is cropped there; may be scaled).

const { createPlanner } = require("../../core/extension-plan.js");
const { NodeInputError, isObject, readNumber, readBoolean, readEnum } = require("../../shared/params.js");

const LIMITS = { targets: 50, canvasMaxSide: 8000 };
const TARGET_ID = /^[A-Za-z0-9._-]{1,80}$/;

function readOptions(params) {
    return {
        batchMode: readEnum(params, "batchMode", ["shared", "independent"], "shared"),
        maxExtensionRatio: readNumber(params, "maxExtensionRatio", { def: 0.5, min: 0.01, max: 3 }),
        allowLarge: readBoolean(params, "allowLarge", false),
        coverageTolerancePx: readNumber(params, "coverageTolerancePx", { def: 2, min: 0, max: 20 }),
    };
}

function normalizeTargets(layout) {
    if (!isObject(layout) || !Array.isArray(layout.targets) || !layout.targets.length) {
        throw new NodeInputError('"layout.targets" must be a non-empty array');
    }
    if (layout.targets.length > LIMITS.targets) throw new NodeInputError(`"layout.targets" has more than ${LIMITS.targets} targets`);
    const seen = new Set();
    return layout.targets.map((t, i) => {
        const where = `layout.targets[${i}]`;
        if (!isObject(t) || typeof t.id !== "string" || !TARGET_ID.test(t.id)) {
            throw new NodeInputError(`"${where}.id" must be 1–80 letters, digits, ".", "_" or "-"`);
        }
        if (seen.has(t.id)) throw new NodeInputError(`target id "${t.id}" appears twice`);
        seen.add(t.id);
        if (!isObject(t.canvas)) throw new NodeInputError(`"${where}.canvas" must be { width, height }`);
        const canvas = {
            width: readNumber(t.canvas, "width", { min: 1, max: LIMITS.canvasMaxSide, integer: true }),
            height: readNumber(t.canvas, "height", { min: 1, max: LIMITS.canvasMaxSide, integer: true }),
        };
        if (!isObject(t.placement)) throw new NodeInputError(`"${where}.placement" must be { x, y, width, height }`);
        const big = LIMITS.canvasMaxSide * 10;
        const placement = {
            x: readNumber(t.placement, "x", { min: -big, max: big }),
            y: readNumber(t.placement, "y", { min: -big, max: big }),
            width: readNumber(t.placement, "width", { min: 1, max: big }),
            height: readNumber(t.placement, "height", { min: 1, max: big }),
        };
        return { id: t.id, canvas, placement };
    });
}

const frameBoundsOf = (t) => [0, 0, t.canvas.height, t.canvas.width];
const graphicBoundsOf = (t) => [t.placement.y, t.placement.x, t.placement.y + t.placement.height, t.placement.x + t.placement.width];

// source: { key, width, height, format } — key identifies the image content (hash)
function planJob({ source, targets, options }) {
    const planner = createPlanner({
        maxExtensionRatio: options.maxExtensionRatio,
        coverageTolerancePt: options.coverageTolerancePx,
    });
    const pages = [];
    const records = targets.map((t) => {
        const frame = frameBoundsOf(t);
        const graphic = graphicBoundsOf(t);
        const u = planner.detectImageUnderfill(frame, graphic);
        const rec = { id: t.id, canvas: t.canvas, placement: t.placement, graphicBounds: graphic, missing: u.missing, status: null, reasons: [], plan: null, masterId: null };
        if (!u.overlaps) {
            rec.status = "failed";
            rec.reasons.push("the placed image doesn't overlap the canvas");
            return rec;
        }
        if (!u.needsExtension) {
            rec.status = "not_required";
            return rec;
        }
        const conv = planner.convertExpansionToSourcePixels(u.missing, graphic, source.width, source.height);
        const plan = planner.createExtensionPlan({
            sourcePath: source.key, sourceWidth: source.width, sourceHeight: source.height, format: source.format,
            missingLayout: u.missing, graphicBounds: graphic, expansionPixels: conv.expansionPixels,
        });
        const eligibility = planner.checkAutoExtensionEligibility(plan);
        rec.plan = plan;
        if (eligibility.eligible || (options.allowLarge && eligibility.overridable)) {
            rec.status = "planned";
            if (!eligibility.eligible) rec.reasons.push(...eligibility.reasons.map((r) => `${r} — generated anyway (allowLarge)`));
            pages.push({ plan, graphicBounds: graphic, ref: rec });
        } else {
            rec.status = "needs_review";
            rec.reasons.push(...eligibility.reasons);
        }
        return rec;
    });

    const groups = options.batchMode === "independent"
        ? pages.map((p) => ({ master: planner.createMasterExtensionPlan([p]), pages: [p] }))
        : planner.groupIntoMasterPlans(pages, { allowLarge: options.allowLarge });

    const units = [];
    for (const g of groups) {
        const e = g.master.eligibility;
        if (!e.eligible && !(options.allowLarge && e.overridable)) {
            // a one-page master can differ slightly from the page plan (resolution measured per page)
            for (const p of g.pages) { p.ref.status = "needs_review"; p.ref.reasons.push(...e.reasons); }
            continue;
        }
        for (const p of g.pages) p.ref.masterId = g.master.id;
        units.push({ master: g.master, targetIds: g.pages.map((p) => p.ref.id) });
    }
    return { planner, targets: records, units };
}

module.exports = { readOptions, normalizeTargets, planJob, LIMITS };
