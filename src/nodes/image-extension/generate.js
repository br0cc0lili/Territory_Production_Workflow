// Image Extension — Firefly generation per master (no SDK; Firefly client,
// fetch and timers are injected).
//
// Per unit (master plan):
//   1. resize the source to the master's working source size (one factor,
//      plan.working — never above the source resolution)
//   2. upload it to Firefly storage, POST /v3/images/expand-async with the
//      plan's working canvas size + inset (the source box is exactly the
//      working source, so Firefly neither moves nor rescales it)
//   3. poll GET /v3/status/<jobId> until succeeded / failed / timeout
//   4. download the output and check it maps onto the requested canvas
//      (checkGeneratedSize — same size, or a uniform rescale)
// Units run in parallel, at most maxConcurrent at a time.

const { loadJimp } = require("../../shared/raster.js");

const DEFAULTS = { pollIntervalMs: 3000, timeoutMs: 240000, maxConcurrent: 3 };
const TERMINAL_FAILED = new Set(["failed", "canceled", "cancelled"]);

const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function generateUnit(unit, ctx) {
    const { firefly, planner, sourceImage, prompt, fetchAsset } = ctx;
    const w = unit.master.working;
    const result = { masterId: unit.master.id, targetIds: unit.targetIds, working: w, fireflyJobId: null, status: "failed", error: null, image: null, generated: null };
    try {
        const src = sourceImage.clone();
        if (src.bitmap.width !== w.source.width || src.bitmap.height !== w.source.height) src.resize({ w: w.source.width, h: w.source.height });
        const png = await src.getBuffer("image/png");
        const uploadId = await firefly.uploadImage(png, "image/png");
        const job = await firefly.submitExpand({ uploadId, size: w.size, inset: w.inset, prompt: prompt || undefined });
        result.fireflyJobId = job.jobId;
        const started = ctx.now();
        let st;
        for (;;) {
            await ctx.sleep(ctx.pollIntervalMs);
            st = await firefly.getJobStatus(job.jobId);
            if (st.status === "succeeded" || TERMINAL_FAILED.has(st.status)) break;
            if (ctx.now() - started > ctx.timeoutMs) throw new Error(`Firefly job did not finish within ${Math.round(ctx.timeoutMs / 1000)} s`);
        }
        if (st.status !== "succeeded") throw new Error(st.error || `Firefly job ${st.status}`);
        const bytes = await fetchAsset(st.outputUrl, { what: "Firefly output" });
        const out = await loadJimp(bytes);
        const check = planner.checkGeneratedSize(w.size, { width: out.bitmap.width, height: out.bitmap.height });
        if (!check.ok) throw new Error(check.reason);
        result.image = out;
        result.generated = { width: out.bitmap.width, height: out.bitmap.height, scale: check.scale, note: check.note || null };
        result.status = "succeeded";
    } catch (e) {
        result.error = e instanceof Error ? e.message : String(e);
    }
    return result;
}

// units: planJob().units. Returns one result per unit, same order.
async function generateUnits(units, opts) {
    const given = Object.fromEntries(Object.entries(opts || {}).filter(([, v]) => v !== undefined)); // unset = default
    const ctx = Object.assign({ sleep: sleepMs, now: Date.now }, DEFAULTS, given);
    const results = new Array(units.length);
    let next = 0;
    async function worker() {
        while (next < units.length) {
            const i = next++;
            results[i] = await generateUnit(units[i], ctx);
        }
    }
    await Promise.all(Array.from({ length: Math.min(ctx.maxConcurrent, units.length) }, worker));
    return results;
}

module.exports = { generateUnits, generateUnit, DEFAULTS };
