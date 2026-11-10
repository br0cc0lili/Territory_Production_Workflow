// Color Detection — node logic (no SDK, no network, no InDesign).
//
// Given a BACKGROUND-ONLY render (the page with the Headline/Subline text
// hidden — scoring a render that still shows the text would measure the
// text's own pixels), the text roles' glyph line boxes and the approved
// palette colours, picks per role the colour that stays most readable in its
// weakest part (src/core/textcolor.js, the plugin's weakest-zone scoring):
//
//   zones per line   n = clamp(round(width / (2 × height)), 1, 12)
//   zoneP10(c, z)    = P10 of WCAG contrast(c, pixel) over zone z
//   score(c)         = min(overall P10, min_z zoneP10)
//   readable         = score ≥ 3:1 (text ≥ 18 pt) / 4.5:1 (smaller)
//
// The best approved colour is ALWAYS returned (never a colour outside the
// palette); below the threshold the role is LOW and the result needs review.
//
//   detectTextColors({ image, layout, palette, options }) -> result (JSON-safe)
//     image:   { width, height, data: RGBA }
//     layout:  normalizeTextLayout() input (see docs/color-detection.md)
//     palette: normalizePalette() input, or { swatches } already parsed
//     options: { largeTextThreshold, normalTextThreshold, largeTextFromPt }

const tc = require("../../core/textcolor.js");
const pal = require("../../core/palette.js");
const { NodeInputError, isObject, readBounds } = require("../../shared/params.js");

const LIMITS = { roles: 10, linesPerRole: 50, swatches: 200 };
const DEFAULT_THRESHOLDS = { large: tc.READABLE.large, normal: tc.READABLE.normal, largeFromPt: tc.READABLE.largeFromPt };

// ---------- inputs ----------

// textLayout JSON -> [{ role, fontSizePt, boxes: [{x,y,width,height}] (image px), source, warnings }]
//   coordinateSpace: { unit: "px" }  (default) — boxes already in background-image pixels
//                    { unit: "pt", pageBounds: [t,l,b,r] } — page coordinates (e.g. InDesign
//                    points); mapped onto the image, which shows exactly pageBounds
//   roles[]: { role, fontSizePt?, lines?: [[t,l,b,r], …], frame?: [t,l,b,r] }
//            lines = one box per glyph line (preferred); frame = fallback only
function normalizeTextLayout(layout, imageSize) {
    if (!isObject(layout)) throw new NodeInputError('"textLayout" must be a JSON object');
    const cs = layout.coordinateSpace === undefined ? { unit: "px" } : layout.coordinateSpace;
    if (!isObject(cs) || !["px", "pt"].includes(cs.unit)) throw new NodeInputError('"textLayout.coordinateSpace.unit" must be "px" or "pt"');
    const warnings = [];
    let map = (b) => ({ x: b[1], y: b[0], width: b[3] - b[1], height: b[2] - b[0] });
    if (cs.unit === "pt") {
        const pb = readBounds(cs.pageBounds, "textLayout.coordinateSpace.pageBounds");
        const sx = imageSize.width / (pb[3] - pb[1]);
        const sy = imageSize.height / (pb[2] - pb[0]);
        if (Math.abs(sx - sy) / Math.max(sx, sy) > 0.01) {
            warnings.push(`background ${imageSize.width}×${imageSize.height} px doesn't have the page's aspect ratio — text boxes mapped per axis`);
        }
        map = (b) => ({ x: (b[1] - pb[1]) * sx, y: (b[0] - pb[0]) * sy, width: (b[3] - b[1]) * sx, height: (b[2] - b[0]) * sy });
    }
    if (!Array.isArray(layout.roles) || !layout.roles.length) throw new NodeInputError('"textLayout.roles" must be a non-empty array');
    if (layout.roles.length > LIMITS.roles) throw new NodeInputError(`"textLayout.roles" has more than ${LIMITS.roles} roles`);
    const seen = new Set();
    const roles = layout.roles.map((r, i) => {
        const where = `textLayout.roles[${i}]`;
        if (!isObject(r) || typeof r.role !== "string" || !/^[A-Za-z0-9 _-]{1,40}$/.test(r.role)) {
            throw new NodeInputError(`"${where}.role" must be a short name such as "headline"`);
        }
        if (seen.has(r.role)) throw new NodeInputError(`role "${r.role}" appears twice`);
        seen.add(r.role);
        const roleWarnings = [];
        let fontSizePt = null;
        if (r.fontSizePt !== undefined && r.fontSizePt !== null) {
            if (typeof r.fontSizePt !== "number" || !(r.fontSizePt > 0) || r.fontSizePt > 2000) throw new NodeInputError(`"${where}.fontSizePt" must be a positive number`);
            fontSizePt = r.fontSizePt;
        } else {
            roleWarnings.push(`${r.role}: no fontSizePt — judged as normal-size text`);
        }
        let source = "lines";
        let rawBoxes = r.lines;
        if (rawBoxes === undefined || rawBoxes === null || (Array.isArray(rawBoxes) && !rawBoxes.length)) {
            if (r.frame === undefined) throw new NodeInputError(`"${where}" needs "lines" (glyph line boxes) or "frame"`);
            rawBoxes = [r.frame];
            source = "frame";
            roleWarnings.push(`${r.role}: scored over the whole text frame (no glyph line boxes) — empty frame areas count as text area`);
        }
        if (!Array.isArray(rawBoxes) || rawBoxes.length > LIMITS.linesPerRole) throw new NodeInputError(`"${where}.lines" must be an array of at most ${LIMITS.linesPerRole} boxes`);
        const boxes = rawBoxes.map((b, k) => map(readBounds(b, source === "frame" ? `${where}.frame` : `${where}.lines[${k}]`)));
        return { role: r.role, fontSizePt, boxes, source, warnings: roleWarnings };
    });
    return { roles, warnings };
}

// palette JSON -> candidate swatches [{ id, name, model, values, rgb, hex }]
//   { swatches: [...], selectedIds?: [...] }  or  { ase: <ArrayBuffer|Uint8Array>, selectedIds? }
//   swatch: { id?, name, model + values (ASE conventions: RGB/CMYK/Gray 0–1,
//             LAB L 0–1 + a/b), or rgb: [0–255 ×3], or hex: "#rrggbb" }
//   selectedIds: only these swatches are candidates (the designer's
//   approved subset); omitted = every swatch in the palette
function normalizePalette(palette) {
    if (!isObject(palette)) throw new NodeInputError('"palette" must be a JSON object');
    let swatches;
    if (palette.ase) {
        swatches = pal.parseASE(palette.ase);
    } else {
        if (!Array.isArray(palette.swatches) || !palette.swatches.length) throw new NodeInputError('"palette.swatches" must be a non-empty array');
        if (palette.swatches.length > LIMITS.swatches) throw new NodeInputError(`"palette.swatches" has more than ${LIMITS.swatches} colours`);
        swatches = palette.swatches.map((s, i) => normalizeSwatch(s, `palette.swatches[${i}]`));
    }
    let candidates = swatches;
    if (palette.selectedIds !== undefined) {
        if (!Array.isArray(palette.selectedIds) || !palette.selectedIds.every((x) => typeof x === "string")) {
            throw new NodeInputError('"palette.selectedIds" must be an array of swatch ids');
        }
        candidates = pal.selectedSwatches({ swatches }, palette.selectedIds);
        const known = new Set(swatches.map((s) => s.id));
        const unknown = palette.selectedIds.filter((id) => !known.has(id));
        if (unknown.length) throw new NodeInputError(`"palette.selectedIds" not in the palette: ${unknown.slice(0, 5).join(", ")}`);
    }
    if (!candidates.length) throw new NodeInputError("no palette colours selected");
    return candidates;
}

const MODEL_SIZES = { RGB: 3, CMYK: 4, LAB: 3, Gray: 1 };
function normalizeSwatch(s, where) {
    if (!isObject(s) || typeof s.name !== "string" || !s.name.trim() || s.name.length > 120) throw new NodeInputError(`"${where}.name" is required`);
    const name = s.name.trim();
    const id = typeof s.id === "string" && s.id ? s.id : name;
    let rgb = null, model = s.model || null, values = s.values || null;
    if (model !== null) {
        if (!MODEL_SIZES[model]) throw new NodeInputError(`"${where}.model" must be RGB, CMYK, LAB or Gray`);
        if (!Array.isArray(values) || values.length !== MODEL_SIZES[model] || !values.every((v) => typeof v === "number" && Number.isFinite(v))) {
            throw new NodeInputError(`"${where}.values" must be ${MODEL_SIZES[model]} numbers for ${model}`);
        }
        if (model !== "LAB" && values.some((v) => v < 0 || v > 1)) {
            throw new NodeInputError(`"${where}.values" for ${model} are 0–1 (Adobe Swatch Exchange convention); use "rgb" for 0–255`);
        }
        rgb = pal.toRgb(model, values);
    } else if (Array.isArray(s.rgb)) {
        if (s.rgb.length !== 3 || !s.rgb.every((v) => Number.isInteger(v) && v >= 0 && v <= 255)) throw new NodeInputError(`"${where}.rgb" must be three integers 0–255`);
        rgb = s.rgb.slice();
    } else if (typeof s.hex === "string" && /^#?[0-9a-fA-F]{6}$/.test(s.hex)) {
        const h = s.hex.replace("#", "");
        rgb = [0, 2, 4].map((k) => parseInt(h.slice(k, k + 2), 16));
    } else {
        throw new NodeInputError(`"${where}" needs model + values, rgb or hex`);
    }
    if (!model) { model = "RGB"; values = rgb.map((v) => v / 255); }
    return { id, name, group: s.group || "", model, values, rgb, hex: pal.hex(rgb) };
}

function readThresholds(options) {
    const o = isObject(options) ? options : {};
    const num = (k, def, min, max) => {
        if (o[k] === undefined || o[k] === null || o[k] === "") return def;
        const n = Number(o[k]);
        if (!Number.isFinite(n) || n < min || n > max) throw new NodeInputError(`"${k}" must be a number between ${min} and ${max}`);
        return n;
    };
    return {
        large: num("largeTextThreshold", DEFAULT_THRESHOLDS.large, 1, 21),
        normal: num("normalTextThreshold", DEFAULT_THRESHOLDS.normal, 1, 21),
        largeFromPt: num("largeTextFromPt", DEFAULT_THRESHOLDS.largeFromPt, 1, 500),
    };
}

// ---------- result ----------

const colorOut = (s) => ({ id: s.id, name: s.name, model: s.model, values: s.values, rgb: s.rgb, hex: s.hex });

// Same wording as the plugin's low-contrast warning (render.js lowContrastWarnings).
function lowContrastWarning(role, name, score, threshold) {
    return `low text contrast — ${role} ${name} reaches ${score}:1 in its weakest part (needs ${threshold}:1); best of the selected colours`;
}

/** @param {{ image: any, layout: any, palette: any, options?: any }} args */
function detectTextColors({ image, layout, palette, options }) {
    if (!image || !(image.width > 0) || !(image.height > 0) || !image.data) throw new NodeInputError("background image could not be decoded");
    const thresholds = readThresholds(options);
    const { roles, warnings: layoutWarnings } = normalizeTextLayout(layout, image);
    const candidates = Array.isArray(palette) ? palette : normalizePalette(palette);
    const warnings = layoutWarnings.slice();
    const out = roles.map((r) => {
        const threshold = r.fontSizePt !== null && r.fontSizePt >= thresholds.largeFromPt ? thresholds.large : thresholds.normal;
        const zones = tc.sampleZones(image, r.boxes);
        const best = tc.chooseTextColorByZones(zones, candidates, threshold);
        warnings.push(...r.warnings);
        const base = { role: r.role, fontSizePt: r.fontSizePt, threshold, source: r.source, lines: r.boxes.length, zones: zones.length };
        if (!best) {
            const w = `${r.role}: its text area lies outside the background image — no colour chosen`;
            warnings.push(w);
            return Object.assign(base, { readability: "NO_DATA", readable: false, color: null, contrast: null, weakest: null, ranking: [], warning: w });
        }
        const readability = best.readable ? "OK" : "LOW";
        const warning = best.readable ? null : lowContrastWarning(r.role, best.swatch.name, best.score, threshold);
        if (warning) warnings.push(warning);
        return Object.assign(base, {
            readability,
            readable: best.readable,
            color: colorOut(best.swatch),
            contrast: { weakestZone: best.score, overallP10: best.overall, mean: best.mean },
            weakest: best.weakest,
            ranking: best.ranking.map((x) => ({ id: x.swatch.id, name: x.swatch.name, hex: x.swatch.hex, weakestZone: x.score, overallP10: x.overall, mean: x.mean })),
            warning,
        });
    });
    const review = out.some((r) => r.readability !== "OK");
    return {
        status: review ? "review" : "ok",
        roles: out,
        warnings,
        summary: out.map((r) => r.color
            ? `${r.role} ${r.color.name} ${r.contrast.weakestZone}:1${r.readable ? "" : ` LOW (< ${r.threshold}:1)`}`
            : `${r.role} —`).join(" | "),
        scoring: { method: "weakest-zone", percentile: tc.SCORE_PERCENTILE, zones: tc.ZONES, thresholds },
        background: { width: image.width, height: image.height },
        candidates: candidates.length,
    };
}

module.exports = { detectTextColors, normalizeTextLayout, normalizePalette, normalizeSwatch, readThresholds, lowContrastWarning, LIMITS };
