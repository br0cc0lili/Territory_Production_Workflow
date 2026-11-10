// Image Extension — compositing one target canvas (no SDK / network).
//
// Layers, bottom to top (the plugin's Image + extendImage layers, flattened):
//   1. the FULL Firefly master image, positioned with
//      computeExtensionCanvasBounds() so its original region lies exactly on
//      the placed original (plugin code) — only its generated areas stay
//      visible
//   2. the ORIGINAL source, resized once to its placement size and pasted
//      at its placement — Firefly's copy of the original is fully replaced,
//      so the original pixels are preserved (bit-identical when the
//      placement is 1:1 at whole-pixel offsets)
//   3. gaps ≤ the coverage tolerance (never sent to Firefly) are filled with
//      the nearest original pixel (edge extension), and reported
// After compositing, the original region is compared pixel by pixel with the
// resized original (originalVerified).

const { blankImage } = require("../../shared/raster.js");

const rect = (x, y, w, h) => ({ x, y, width: w, height: h });

function placementRect(p) {
    const x = Math.round(p.x), y = Math.round(p.y);
    return rect(x, y, Math.max(1, Math.round(p.x + p.width) - x), Math.max(1, Math.round(p.y + p.height) - y));
}

function clipRect(r, W, H) {
    const x0 = Math.max(0, r.x), y0 = Math.max(0, r.y);
    const x1 = Math.min(W, r.x + r.width), y1 = Math.min(H, r.y + r.height);
    return x1 > x0 && y1 > y0 ? rect(x0, y0, x1 - x0, y1 - y0) : null;
}

const inside = (r, x, y) => r && x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height;

// target: planJob() record; unit: generateUnits() result (or null = not extended)
function composeTarget({ planner, target, sourceImage, unit }) {
    const W = target.canvas.width, H = target.canvas.height;
    const canvas = blankImage(W, H, 0x00000000);
    let extRect = null;
    if (unit) {
        const [t, l, b, r] = planner.computeExtensionCanvasBounds(target.graphicBounds, unit.working);
        extRect = rect(Math.round(l), Math.round(t), Math.max(1, Math.round(r) - Math.round(l)), Math.max(1, Math.round(b) - Math.round(t)));
        const ext = unit.image.clone().resize({ w: extRect.width, h: extRect.height });
        canvas.composite(ext, extRect.x, extRect.y);
    }
    const o = placementRect(target.placement);
    const original = sourceImage.clone();
    if (original.bitmap.width !== o.width || original.bitmap.height !== o.height) original.resize({ w: o.width, h: o.height });
    // replace, don't blend: the original wins wherever it is
    const oc = clipRect(o, W, H);
    if (!oc) throw new Error(`target ${target.id}: the placed image doesn't overlap the canvas`);
    const cd = canvas.bitmap.data, od = original.bitmap.data;
    for (let y = oc.y; y < oc.y + oc.height; y++) {
        const s = ((y - o.y) * o.width + (oc.x - o.x)) * 4;
        cd.set(od.subarray(s, s + oc.width * 4), (y * W + oc.x) * 4);
    }

    // gaps neither layer covers (≤ tolerance): nearest original pixel
    const ec = extRect && clipRect(extRect, W, H);
    let edgeFilled = 0;
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            if (inside(oc, x, y) || inside(ec, x, y)) continue;
            const sx = Math.min(oc.x + oc.width - 1, Math.max(oc.x, x));
            const sy = Math.min(oc.y + oc.height - 1, Math.max(oc.y, y));
            const si = (sy * W + sx) * 4, di = (y * W + x) * 4;
            cd[di] = cd[si]; cd[di + 1] = cd[si + 1]; cd[di + 2] = cd[si + 2]; cd[di + 3] = cd[si + 3];
            edgeFilled++;
        }
    }

    // verify: the original region equals the resized original
    let originalVerified = true;
    for (let y = oc.y; y < oc.y + oc.height && originalVerified; y++) {
        const s = ((y - o.y) * o.width + (oc.x - o.x)) * 4;
        const a = od.subarray(s, s + oc.width * 4), b = cd.subarray((y * W + oc.x) * 4, (y * W + oc.x + oc.width) * 4);
        originalVerified = Buffer.compare(Buffer.from(a.buffer, a.byteOffset, a.length), Buffer.from(b.buffer, b.byteOffset, b.length)) === 0;
    }
    return {
        image: canvas,
        originalRegion: oc,
        originalScale: { x: Math.round((o.width / sourceImage.bitmap.width) * 10000) / 10000, y: Math.round((o.height / sourceImage.bitmap.height) * 10000) / 10000 },
        extensionRegion: ec,
        edgeFilledPx: edgeFilled,
        originalVerified,
    };
}

module.exports = { composeTarget, placementRect, clipRect };
