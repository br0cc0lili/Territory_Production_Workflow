// REUSED from Territory_InDesign_Plugin plugin/js/textcolor.js @ c19c056 —
// scoring code unchanged. Removed: decodeJpeg (UXP JPEG decoder; the node
// decodes with src/shared/raster.js). Keep in sync until the plugin and the
// nodes share one copy.
//
// textcolor.js — AUTO TEXT COLOR: which of the designer's selected palette
// colours reads best on the final composition behind the Headline/Subline
// (render.js uses the weakest-zone scoring further down, per text role).
//
// Pure functions (no InDesign): render.js renders the page with the text
// hidden, decodes the JPG and passes the pixels + the text area here.
//
// Readability = WCAG 2 contrast ratio between the text colour and each
// background pixel ((L1 + 0.05) / (L2 + 0.05), L = relative luminance). A
// colour's score is the contrast that 90 % of the text area reaches (10th
// percentile) — one bright highlight or dark corner doesn't decide it; the
// mean contrast breaks ties.

const SCORE_PERCENTILE = 0.10;
const MAX_SAMPLES = 40000; // pixels sampled per text area (evenly spaced)

const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
// PURE. WCAG relative luminance of an sRGB colour (0–255).
function relativeLuminance(r, g, b) {
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

// PURE. WCAG contrast ratio of two luminances (1 … 21).
function contrastRatio(l1, l2) {
    const hi = Math.max(l1, l2), lo = Math.min(l1, l2);
    return (hi + 0.05) / (lo + 0.05);
}

// PURE. Luminances of the pixels inside `box` ({ x, y, width, height } in
// image pixels) of an RGBA image ({ width, height, data }), evenly
// sub-sampled to at most MAX_SAMPLES. Returns a Float32Array.
function sampleLuminances(image, box) {
    const x0 = Math.max(0, Math.floor(box.x)), y0 = Math.max(0, Math.floor(box.y));
    const x1 = Math.min(image.width, Math.ceil(box.x + box.width)), y1 = Math.min(image.height, Math.ceil(box.y + box.height));
    const w = x1 - x0, h = y1 - y0;
    if (w <= 0 || h <= 0) return new Float32Array(0);
    const step = Math.max(1, Math.ceil(Math.sqrt((w * h) / MAX_SAMPLES)));
    const out = [];
    for (let y = y0; y < y1; y += step) {
        for (let x = x0; x < x1; x += step) {
            const i = (y * image.width + x) * 4;
            out.push(relativeLuminance(image.data[i], image.data[i + 1], image.data[i + 2]));
        }
    }
    return Float32Array.from(out);
}

function percentile(sorted, p) {
    if (!sorted.length) return 0;
    return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))))];
}

// PURE. Ranks candidate swatches ({ rgb:[r,g,b], … }) on a background
// (luminances). Returns [{ swatch, score, mean }], best first.
function rankColors(luminances, candidates) {
    const ranked = [];
    for (const swatch of candidates || []) {
        if (!swatch || !swatch.rgb) continue;
        const lt = relativeLuminance(swatch.rgb[0], swatch.rgb[1], swatch.rgb[2]);
        const cr = Array.from(luminances, (lb) => contrastRatio(lt, lb)).sort((a, b) => a - b);
        const mean = cr.reduce((s, v) => s + v, 0) / (cr.length || 1);
        ranked.push({ swatch, score: Math.round(percentile(cr, SCORE_PERCENTILE) * 100) / 100, mean: Math.round(mean * 100) / 100 });
    }
    return ranked.sort((a, b) => b.score - a.score || b.mean - a.mean);
}

// PURE. The best candidate, or null (no candidates / no pixels).
function chooseTextColor(luminances, candidates) {
    if (!luminances || !luminances.length) return null;
    const ranked = rankColors(luminances, candidates);
    return ranked.length ? Object.assign({ ranking: ranked }, ranked[0]) : null;
}

// ---------- weakest-zone scoring (Headline / Subline separately) ----------
//
// A single score over one big text box can hide a bad part: "Marderabwehr"
// over bright metal AND a dark cable averages out fine but half the word is
// hard to read. So each text role (headline, subline) is scored on its own
// glyph lines, each line cut into horizontal zones, and a colour is only as
// good as its WEAKEST zone:
//   zoneP10(c, z)  = P10 { CR(c, p) : p in zone z }
//   overallP10(c)  = P10 { CR(c, p) : p in all lines of the role }
//   score(c)       = min(overallP10(c), min_z zoneP10(c, z))
// Ties: overallP10, then the mean. Readable when score ≥ the WCAG threshold
// for the text size (readabilityThreshold).
const ZONES = { maxPerLine: 12, widthPerHeight: 2, minPixels: 12 };
const READABLE = { large: 3.0, normal: 4.5, largeFromPt: 18 };

// PURE. WCAG 2 contrast threshold for text of this size (pt): large text
// (≥ 18 pt) 3:1, otherwise 4.5:1.
function readabilityThreshold(pointSize) {
    return Number(pointSize) >= READABLE.largeFromPt ? READABLE.large : READABLE.normal;
}

// PURE. The zones of a role's lines: each line box ({ x, y, width, height },
// image pixels) cut into n = clamp(round(width / (2 × height)), 1, 12)
// equal horizontal zones (fewer if a zone would have < minPixels pixels).
// Returns [{ line, zone, lum: Float32Array }] (empty zones dropped).
function sampleZones(image, lineBoxes) {
    const zones = [];
    (lineBoxes || []).forEach((b, line) => {
        if (!b || !(b.width > 0) || !(b.height > 0)) return;
        let n = Math.max(1, Math.min(ZONES.maxPerLine, Math.round(b.width / (ZONES.widthPerHeight * b.height))));
        while (n > 1 && (b.width / n) * b.height < ZONES.minPixels) n--;
        for (let k = 0; k < n; k++) {
            const lum = sampleLuminances(image, { x: b.x + (k * b.width) / n, y: b.y, width: b.width / n, height: b.height });
            if (lum.length) zones.push({ line, zone: k, lum });
        }
    });
    return zones;
}

// PURE. One colour (rgb 0–255) against a role's zones:
// { score, overall, mean, weakest: { line, zone, p10 } }.
function scoreZones(zones, rgb) {
    const lt = relativeLuminance(rgb[0], rgb[1], rgb[2]);
    const all = [];
    let weakest = null;
    for (const z of zones) {
        const cr = Array.from(z.lum, (lb) => contrastRatio(lt, lb)).sort((a, b) => a - b);
        const p10 = percentile(cr, SCORE_PERCENTILE);
        if (!weakest || p10 < weakest.p10) weakest = { line: z.line, zone: z.zone, p10 };
        for (const v of cr) all.push(v);
    }
    all.sort((a, b) => a - b);
    const overall = percentile(all, SCORE_PERCENTILE);
    const mean = all.reduce((s, v) => s + v, 0) / (all.length || 1);
    const r2 = (v) => Math.round(v * 100) / 100;
    return { score: r2(Math.min(overall, weakest ? weakest.p10 : overall)), overall: r2(overall), mean: r2(mean),
        weakest: weakest && { line: weakest.line, zone: weakest.zone, p10: r2(weakest.p10) } };
}

// PURE. The best candidate swatch for one role, or null (no zones / no
// candidates): { swatch, score, overall, mean, weakest, threshold, readable,
// ranking: [{ swatch, score, overall, mean }] }. The best is returned even
// when it isn't readable (readable: false) — the caller applies it AND warns.
function chooseTextColorByZones(zones, candidates, threshold) {
    if (!zones || !zones.length) return null;
    const ranked = (candidates || []).filter((s) => s && s.rgb)
        .map((swatch) => Object.assign({ swatch }, scoreZones(zones, swatch.rgb)))
        .sort((a, b) => b.score - a.score || b.overall - a.overall || b.mean - a.mean);
    if (!ranked.length) return null;
    const t = threshold || READABLE.normal;
    return Object.assign({ ranking: ranked, threshold: t, readable: ranked[0].score >= t }, ranked[0]);
}

module.exports = { relativeLuminance, contrastRatio, sampleLuminances, rankColors, chooseTextColor, SCORE_PERCENTILE,
    readabilityThreshold, sampleZones, scoreZones, chooseTextColorByZones, READABLE, ZONES };
