// extension-plan.js — Image Extension PLANNING (pure geometry, no I/O).
//
// REUSED from Territory_InDesign_Plugin plugin/js/imageextension.js @ c19c056.
// The functions below are copied verbatim (comments included); only these
// changes were made:
//   - wrapped in createPlanner(config) so a workflow can set its own limits
//     per job (the plugin reads one module-level CONFIG);
//   - CONFIG reduced to the planning settings;
//   - InDesign/UXP parts left out: getPlacedGraphic, transformProblem,
//     readImagePixelSize, pixelSizeFromInDesign, captureGeometrySnapshot,
//     analyzeImageCoverage, backend calls, asset store, extendImage layer,
//     checkExtendedCoverage, reports; the per-run plan registry is not needed
//     (one job = one grouping pass; cross-job caching is postponed).
//
// Units: the plugin works in layout points with 1 pt = 1 px in the final
// 72 dpi export. Here "layout units" are TARGET CANVAS PIXELS, so
// outputPxPerPt = Firefly working px per output px (1 = full resolution).
// Bounds are [top, left, bottom, right].

const DEFAULT_CONFIG = {
    // Gaps up to this many canvas px per side are rounding noise: never sent to Firefly.
    coverageTolerancePt: 2,
    // Firefly may generate at most this share of the source on either axis (automatic limit).
    maxExtensionRatio: 0.5,
    // Firefly Generative Expand output limit per side (px).
    fireflyMaxSide: 2688,
    // Required Firefly working px per output (canvas) px.
    outputPxPerPt: 1,
    // Source formats Firefly Expand accepts.
    fireflyFormats: ["jpeg", "png", "webp"],
    extension: {
        // Output size vs requested Firefly canvas: allowed aspect difference for a uniform rescale.
        aspectTolerance: 0.005,
    },
};

function createPlanner(overrides) {
    const o = overrides || {};
    const CONFIG = Object.assign({}, DEFAULT_CONFIG, o, { extension: Object.assign({}, DEFAULT_CONFIG.extension, o.extension || {}) });

    // [top, left, bottom, right] -> { top, left, bottom, right, width, height }
    function toBox(b) {
        const [top, left, bottom, right] = [0, 1, 2, 3].map((i) => Number(b[i]));
        return { top, left, bottom, right, width: right - left, height: bottom - top };
    }

    function round2(n) {
        return Math.round(n * 100) / 100;
    }

    function sides(fn) {
        return { top: fn("top"), right: fn("right"), bottom: fn("bottom"), left: fn("left") };
    }

    // PURE. How much of the frame the graphic leaves uncovered, per side, in
    // layout units. Each side is checked independently (the image may be offset).
    //   frameBounds / graphicBounds: [top, left, bottom, right]
    // Returns { needsExtension, missing: {top,right,bottom,left}, missingRaw }.
    // Gaps up to `tolerance` count as covered (missing 0).
    function detectImageUnderfill(frameBounds, graphicBounds, tolerance) {
        const tol = tolerance === undefined ? CONFIG.coverageTolerancePt : tolerance;
        const f = toBox(frameBounds);
        const g = toBox(graphicBounds);
        const missingRaw = {
            top: Math.max(0, g.top - f.top),
            right: Math.max(0, f.right - g.right),
            bottom: Math.max(0, f.bottom - g.bottom),
            left: Math.max(0, g.left - f.left),
        };
        const missing = sides((s) => (missingRaw[s] > tol ? round2(missingRaw[s]) : 0));
        const needsExtension = Object.values(missing).some((v) => v > 0);
        // A graphic that doesn't even overlap the frame can't be extended sensibly.
        const overlaps = g.right > f.left && g.left < f.right && g.bottom > f.top && g.top < f.bottom;
        return { needsExtension, missing, missingRaw: sides((s) => round2(missingRaw[s])), overlaps };
    }

    // Pixel size from the image file header (JPEG SOFn / PNG IHDR / WebP).
    // Returns { width, height, format } or null if unreadable / unsupported.
    function parseImageHeader(bytes) {
        const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
        const u16be = (i) => (b[i] << 8) | b[i + 1];
        const u32be = (i) => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
        // PNG
        if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
            return { width: u32be(16), height: u32be(20), format: "png" };
        }
        // JPEG: walk the markers to the first SOFn
        if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
            let i = 2;
            while (i + 9 < b.length) {
                if (b[i] !== 0xff) { i++; continue; }
                const marker = b[i + 1];
                if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
                const len = u16be(i + 2);
                const isSOF = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
                if (isSOF) return { width: u16be(i + 7), height: u16be(i + 5), format: "jpeg" };
                if (len < 2) break;
                i += 2 + len;
            }
            return null;
        }
        // WebP (RIFF....WEBP)
        if (b.length > 30 && b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57 && b[9] === 0x45) {
            const chunk = String.fromCharCode(b[12], b[13], b[14], b[15]);
            if (chunk === "VP8X") return { width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)), format: "webp" };
            if (chunk === "VP8 ") return { width: (b[26] | (b[27] << 8)) & 0x3fff, height: (b[28] | (b[29] << 8)) & 0x3fff, format: "webp" };
            if (chunk === "VP8L") {
                const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
                return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1, format: "webp" };
            }
        }
        return null;
    }

    // PURE. Converts the missing layout area into source-image pixels.
    //   missing: {top,right,bottom,left} in layout units
    //   graphicBounds: the placed graphic's bounds (full image, incl. cropped parts)
    //   sourceWidth/Height: the original image's pixel size
    // Per axis: source px per layout unit = source px / graphic size. Each side is
    // rounded UP so the extension is never short of the frame.
    function convertExpansionToSourcePixels(missing, graphicBounds, sourceWidth, sourceHeight) {
        const g = toBox(graphicBounds);
        const ratioX = sourceWidth / g.width;
        const ratioY = sourceHeight / g.height;
        const expansionPixels = {
            top: Math.ceil(missing.top * ratioY),
            right: Math.ceil(missing.right * ratioX),
            bottom: Math.ceil(missing.bottom * ratioY),
            left: Math.ceil(missing.left * ratioX),
        };
        return {
            sourceWidth, sourceHeight,
            ratio: { x: round2(ratioX), y: round2(ratioY) },
            missingLayout: missing,
            expansionPixels,
            targetWidth: sourceWidth + expansionPixels.left + expansionPixels.right,
            targetHeight: sourceHeight + expansionPixels.top + expansionPixels.bottom,
        };
    }

    // FNV-1a 32-bit — a small deterministic hash for plan ids.
    function fnv1a(str) {
        let h = 0x811c9dc5;
        for (let i = 0; i < str.length; i++) {
            h ^= str.charCodeAt(i);
            h = Math.imul(h, 0x01000193) >>> 0;
        }
        return ("00000000" + h.toString(16)).slice(-8);
    }

    // PURE. Firefly working resolution for a plan: never above the source
    // (scale <= 1), only as far down as Firefly's per-side limit requires. ONE
    // factor for source, expansion/inset and canvas, so the geometry is the same
    // plan at a lower resolution. Also checks the extended image still gives the
    // final output CONFIG.outputPxPerPt px per point.
    //   canvasLayout: { width, height } the extended canvas covers, in layout units
    // PURE. The Firefly working geometry for a source + extension (source px):
    // ONE scale factor for source, extension/inset and canvas, rounded only at
    // the end — source down, insets up (so the generated area always covers the
    // gap). That rounding can add up to 1 px per extended side pair (e.g.
    // floor(2569.4) + ceil(59.25) + ceil(59.25) = 2689), so the factor is
    // reduced slightly until the rounded canvas fits fireflyMaxSide.
    // Returns { scale, exactScale, downscaled, source, size, inset, originalTarget }.
    function fitWorkingGeometry(sourceWidth, sourceHeight, expansionPixels) {
        const max = CONFIG.fireflyMaxSide;
        const targetWidth = sourceWidth + expansionPixels.left + expansionPixels.right;
        const targetHeight = sourceHeight + expansionPixels.top + expansionPixels.bottom;
        let scale = Math.min(1, max / targetWidth, max / targetHeight);
        let source, inset, size;
        for (let i = 0; i < 20; i++) {
            source = { width: Math.floor(sourceWidth * scale), height: Math.floor(sourceHeight * scale) };
            inset = sides((side) => Math.ceil(expansionPixels[side] * scale - 1e-9));
            size = { width: source.width + inset.left + inset.right, height: source.height + inset.top + inset.bottom };
            if (size.width <= max && size.height <= max) break;
            // over by rounding only: shrink the factor by the overshoot (+ a hair)
            scale = scale * Math.min(max / size.width, max / size.height) - 1e-7;
        }
        return {
            scale: Math.round(scale * 1e6) / 1e6,
            exactScale: scale,
            downscaled: scale < 1,
            source, size, inset,
            originalTarget: { width: targetWidth, height: targetHeight },
        };
    }

    function computeWorkingResolution(sourceWidth, sourceHeight, expansionPixels, canvasLayout) {
        const w = fitWorkingGeometry(sourceWidth, sourceHeight, expansionPixels);
        const pxPerPt = Math.min(w.size.width / canvasLayout.width, w.size.height / canvasLayout.height);
        return {
            scale: w.scale,
            downscaled: w.downscaled,
            source: w.source, size: w.size, inset: w.inset,
            originalTarget: w.originalTarget,          // full source-resolution canvas
            pxPerPt: round2(pxPerPt),
            requiredPxPerPt: CONFIG.outputPxPerPt,
            resolutionOk: pxPerPt >= CONFIG.outputPxPerPt,
        };
    }

    // PURE. The exact extension plan for one page: what Firefly would have to
    // generate, nothing more. Its identity is the generation request itself —
    // source image + size, the required expansion on each side, and the working
    // request (size + inset) — all derived from the FINAL geometry. No placement
    // concepts (anchor, fit mode) are part of it: two pages with the same source
    // and the same required expansion need the very same generated asset, however
    // placement got there. Different requirements never share a plan.
    //   input: { sourcePath, sourceWidth, sourceHeight, format,
    //            missingLayout, graphicBounds, expansionPixels }
    function createExtensionPlan(input) {
        const g = toBox(input.graphicBounds);
        const m = input.missingLayout;
        const canvasLayout = { width: g.width + m.left + m.right, height: g.height + m.top + m.bottom };
        const e = input.expansionPixels;
        const working = computeWorkingResolution(input.sourceWidth, input.sourceHeight, e, canvasLayout);
        const ratio = {
            x: round2((e.left + e.right) / input.sourceWidth),
            y: round2((e.top + e.bottom) / input.sourceHeight),
        };
        ratio.max = Math.max(ratio.x, ratio.y);
        const key = JSON.stringify([
            String(input.sourcePath).toLowerCase(), input.sourceWidth, input.sourceHeight,
            e.top, e.right, e.bottom, e.left,
            working.size.width, working.size.height,
            working.inset.top, working.inset.right, working.inset.bottom, working.inset.left,
        ]);
        return {
            id: "EXT_" + fnv1a(key),
            key,
            source: { path: input.sourcePath, width: input.sourceWidth, height: input.sourceHeight, format: input.format },
            expansionPixels: e,
            target: { width: input.sourceWidth + e.left + e.right, height: input.sourceHeight + e.top + e.bottom },
            ratio,
            working,
        };
    }

    // PURE. May Firefly extend this plan automatically?
    // Returns { eligible, reasons: [], overridable }.
    //   overridable: not eligible ONLY because of the soft limits (extension
    //   over maxExtensionRatio, or output resolution below outputPxPerPt) — the
    //   designer may still start it by hand (Extend Image, after a warning).
    //   Unsupported file type / Firefly canvas size are hard limits.
    function checkAutoExtensionEligibility(plan) {
        const reasons = [];
        let hard = false;
        if (CONFIG.fireflyFormats.indexOf(plan.source.format) === -1) {
            reasons.push(`unsupported image type for Firefly: ${plan.source.format}`);
            hard = true;
        }
        if (plan.ratio.max > CONFIG.maxExtensionRatio) {
            reasons.push(`Required extension exceeds automatic generation limit ` +
                `(${Math.round(plan.ratio.max * 100)}% > ${Math.round(CONFIG.maxExtensionRatio * 100)}%)`);
        }
        if (plan.working.size.width > CONFIG.fireflyMaxSide || plan.working.size.height > CONFIG.fireflyMaxSide) {
            reasons.push(`Firefly canvas ${plan.working.size.width}×${plan.working.size.height} exceeds ${CONFIG.fireflyMaxSide} px`);
            hard = true;
        }
        if (!plan.working.resolutionOk) {
            reasons.push(`Firefly's ${CONFIG.fireflyMaxSide} px limit can't give the output enough resolution ` +
                `(${plan.working.pxPerPt} px/pt < ${CONFIG.outputPxPerPt})`);
        }
        return { eligible: reasons.length === 0, reasons, overridable: reasons.length > 0 && !hard };
    }

    // PURE. Does the returned image map onto the requested Firefly canvas?
    // Same size → scale 1; same aspect (uniform rescale) → that scale; else not
    // alignable (never guessed).
    function checkGeneratedSize(requested, returned) {
        if (!returned || !returned.width || !returned.height) return { ok: false, reason: "output size unknown" };
        if (returned.width === requested.width && returned.height === requested.height) return { ok: true, scale: 1 };
        const sx = returned.width / requested.width;
        const sy = returned.height / requested.height;
        if (Math.abs(sx - sy) / Math.max(sx, sy) <= CONFIG.extension.aspectTolerance) {
            return { ok: true, scale: Math.round(sx * 10000) / 10000, note: "uniformly rescaled by Firefly" };
        }
        return { ok: false, reason: `Firefly returned ${returned.width}×${returned.height}, requested ${requested.width}×${requested.height} — can't be aligned` };
    }

    // PURE. One master extension plan covering several pages' plans of the SAME
    // source: per side, the largest extension any page needs (source px). Each
    // page then clips its own strip from the master result — its required area
    // is always inside the master canvas. Resolution is checked per page at the
    // master's working scale.
    //   members: [{ plan, graphicBounds }] (page plans from analyzeImageCoverage)
    // Returns the plan (same shape as createExtensionPlan + kind/members), with
    // `eligibility` = checkAutoExtensionEligibility(master).
    function createMasterExtensionPlan(members) {
        const src = members[0].plan.source;
        const e = sides((side) => Math.max.apply(null, members.map((m) => m.plan.expansionPixels[side])));
        const targetWidth = src.width + e.left + e.right;
        const targetHeight = src.height + e.top + e.bottom;
        // Same normalisation as a page plan: the whole master geometry scaled by
        // one factor so the Firefly canvas fits fireflyMaxSide.
        const fit = fitWorkingGeometry(src.width, src.height, e);
        const { source, inset, size } = fit;
        // Output px per layout pt on each member page at this working scale.
        const pxPerPt = Math.min.apply(null, members.map((m) => {
            const g = toBox(m.graphicBounds);
            return Math.min(source.width / g.width, source.height / g.height);
        }));
        const working = {
            scale: fit.scale, downscaled: fit.downscaled, source, size, inset, originalTarget: fit.originalTarget,
            pxPerPt: round2(pxPerPt), requiredPxPerPt: CONFIG.outputPxPerPt, resolutionOk: pxPerPt >= CONFIG.outputPxPerPt,
        };
        const ratio = { x: round2((e.left + e.right) / src.width), y: round2((e.top + e.bottom) / src.height) };
        ratio.max = Math.max(ratio.x, ratio.y);
        const key = JSON.stringify(["master", String(src.path).toLowerCase(), src.width, src.height,
            e.top, e.right, e.bottom, e.left, size.width, size.height, inset.top, inset.right, inset.bottom, inset.left]);
        const plan = {
            id: "EXT_" + fnv1a(key), key, kind: "master",
            source: src, expansionPixels: e, target: { width: targetWidth, height: targetHeight }, ratio, working,
            members: members.map((m) => m.plan.id),
        };
        plan.eligibility = checkAutoExtensionEligibility(plan);
        return plan;
    }

    // PURE. Groups a batch's eligible pages into as FEW master plans as possible
    // (normally one). Pages are only separated when a shared master is
    // genuinely impossible: a different source image, or adding the page would
    // make the master ineligible (combined extension over the limit, or a
    // page's output resolution too low at the master's working scale).
    //   pages: [{ plan, graphicBounds, ref }] — ref is returned untouched
    //   options.allowLarge: a manual Extend of over-limit pages — a master that
    //   is only over the soft limits may still be shared
    // Returns [{ master, pages }] (deterministic: input order).
    function groupIntoMasterPlans(pages, options) {
        const allowLarge = !!(options && options.allowLarge);
        const groups = [];
        for (const p of pages) {
            let placed = false;
            for (const g of groups) {
                if (g.sourceKey !== String(p.plan.source.path).toLowerCase() + "|" + p.plan.source.width + "x" + p.plan.source.height) continue;
                const trial = createMasterExtensionPlan(g.pages.concat([p]));
                if (!trial.eligibility.eligible && !(allowLarge && trial.eligibility.overridable)) continue;
                g.pages.push(p);
                g.master = trial;
                placed = true;
                break;
            }
            if (!placed) {
                groups.push({
                    sourceKey: String(p.plan.source.path).toLowerCase() + "|" + p.plan.source.width + "x" + p.plan.source.height,
                    pages: [p], master: createMasterExtensionPlan([p]),
                });
            }
        }
        return groups.map((g) => ({ master: g.master, pages: g.pages }));
    }

    // PURE. Where the full expanded image goes in layout units, so its original
    // region coincides with the original graphic:
    //   graphicBounds: the original graphic's bounds [t, l, b, r]
    //   working: plan.working (source = the region Firefly kept, inset, size)
    // One working px = graphic size / working source size (per axis — the
    // backend resized the source to exactly working.source).
    function computeExtensionCanvasBounds(graphicBounds, working) {
        const g = toBox(graphicBounds);
        const ux = g.width / working.source.width;
        const uy = g.height / working.source.height;
        const top = g.top - working.inset.top * uy;
        const left = g.left - working.inset.left * ux;
        return [top, left, top + working.size.height * uy, left + working.size.width * ux];
    }

    // PURE. a minus b → up to 4 boxes ({top,left,bottom,right}).
    function subtractBox(a, b) {
        const t = Math.max(a.top, b.top), l = Math.max(a.left, b.left);
        const btm = Math.min(a.bottom, b.bottom), r = Math.min(a.right, b.right);
        if (t >= btm || l >= r) return [a];
        const out = [];
        if (a.top < t) out.push({ top: a.top, left: a.left, bottom: t, right: a.right });
        if (btm < a.bottom) out.push({ top: btm, left: a.left, bottom: a.bottom, right: a.right });
        if (a.left < l) out.push({ top: t, left: a.left, bottom: btm, right: l });
        if (r < a.right) out.push({ top: t, left: r, bottom: btm, right: a.right });
        return out;
    }

    // PURE. Parts of `frameBounds` not covered by any of `covers` (bounds
    // arrays). Slivers up to `tolerance` thick are ignored (rounding noise).
    function uncoveredBoxes(frameBounds, covers, tolerance) {
        const tol = tolerance === undefined ? CONFIG.coverageTolerancePt : tolerance;
        let left = [toBox(frameBounds)];
        for (const c of covers) {
            const cb = toBox(c);
            left = left.reduce((acc, box) => acc.concat(subtractBox(box, cb)), []);
        }
        return left.filter((b) => b.bottom - b.top > tol && b.right - b.left > tol)
            .map((b) => [b.top, b.left, b.bottom, b.right].map(round2));
    }

    function intersectBounds(a, b) {
        return [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
    }

    return {
        CONFIG, toBox, round2, detectImageUnderfill, parseImageHeader, convertExpansionToSourcePixels, fnv1a,
        fitWorkingGeometry, computeWorkingResolution, createExtensionPlan, checkAutoExtensionEligibility,
        checkGeneratedSize, createMasterExtensionPlan, groupIntoMasterPlans, computeExtensionCanvasBounds,
        subtractBox, uncoveredBoxes, intersectBounds,
    };
}

module.exports = { createPlanner, DEFAULT_CONFIG };
