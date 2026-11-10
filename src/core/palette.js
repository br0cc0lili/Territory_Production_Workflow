// REUSED from Territory_InDesign_Plugin plugin/js/colorpalette.js @ c19c056 —
// parsing / conversion code unchanged. Removed: loadPalette (UXP file read;
// the node fetches the .ase over HTTPS). Added to exports: hex.
//
// colorpalette.js — COLOR PALETTE for Auto Text Color: reads an Adobe
// Swatch Exchange (.ase) file and keeps the swatches the designer selected.
//
// ASE layout (big-endian): "ASEF", version (2 × uint16), block count
// (uint32), then blocks: type (uint16) + length (uint32) + body.
//   0x0001 colour entry: name length (uint16, UTF-16 units incl. NUL),
//          name (UTF-16BE), model ("RGB " | "CMYK" | "LAB " | "Gray"),
//          float32 values, colour type (uint16: 0 global, 1 spot, 2 normal)
//   0xC001 group start (name only), 0xC002 group end
//
// Every swatch also gets an sRGB approximation (rgb 0–255, hex) — used only
// to judge contrast and to draw the swatch in the panel. In InDesign the
// colour is created in its ORIGINAL model (inDesignColor), so a CMYK print
// colour stays CMYK.

const clamp255 = (v) => Math.max(0, Math.min(255, Math.round(v)));

// LAB (D50) → sRGB, the usual approximation (enough for contrast ranking).
function labToRgb(L, a, b) {
    const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
    const f = (t) => (t ** 3 > 0.008856 ? t ** 3 : (t - 16 / 116) / 7.787);
    const X = 0.9642 * f(fx), Y = 1.0 * f(fy), Z = 0.8251 * f(fz);
    // D50 → linear sRGB (Bradford-adapted)
    const lin = [
        3.1338561 * X - 1.6168667 * Y - 0.4906146 * Z,
        -0.9787684 * X + 1.9161415 * Y + 0.0334540 * Z,
        0.0719453 * X - 0.2289914 * Y + 1.4052427 * Z,
    ];
    return lin.map((c) => clamp255(255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(Math.max(c, 0), 1 / 2.4) - 0.055)));
}

// PURE. sRGB (0–255) for a swatch's model + values (ASE floats).
function toRgb(model, v) {
    if (model === "RGB") return v.map((x) => clamp255(x * 255));
    if (model === "CMYK") {
        const [c, m, y, k] = v;
        return [255 * (1 - c) * (1 - k), 255 * (1 - m) * (1 - k), 255 * (1 - y) * (1 - k)].map(clamp255);
    }
    if (model === "LAB") return labToRgb(v[0] * 100, v[1], v[2]);
    if (model === "Gray") return [0, 0, 0].map(() => clamp255(v[0] * 255));
    return null;
}

const hex = (rgb) => "#" + rgb.map((n) => ("0" + n.toString(16)).slice(-2)).join("");

// PURE. Parses ASE bytes. Returns [{ name, group, model, values, type,
// rgb:[r,g,b], hex, id }]; throws on a file that isn't ASE.
function parseASE(bytes) {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    if (b.length < 12 || String.fromCharCode(b[0], b[1], b[2], b[3]) !== "ASEF") throw new Error("not an Adobe Swatch Exchange (.ase) file");
    const count = dv.getUint32(8);
    const sizes = { "RGB ": 3, CMYK: 4, "LAB ": 3, Gray: 1 };
    const swatches = [];
    let group = "";
    let i = 12;
    for (let n = 0; n < count && i + 6 <= b.length; n++) {
        const type = dv.getUint16(i);
        const len = dv.getUint32(i + 2);
        const start = i + 6;
        i = start + len;
        if (type === 0xC002) { group = ""; continue; }
        if (type !== 0x0001 && type !== 0xC001) continue;
        const nameLen = dv.getUint16(start);
        let name = "";
        for (let k = 0; k < nameLen; k++) {
            const ch = dv.getUint16(start + 2 + 2 * k);
            if (ch) name += String.fromCharCode(ch);
        }
        name = name.trim();
        if (type === 0xC001) { group = name; continue; }
        let j = start + 2 + 2 * nameLen;
        const modelRaw = String.fromCharCode(b[j], b[j + 1], b[j + 2], b[j + 3]);
        j += 4;
        const size = sizes[modelRaw];
        if (!size) continue; // unknown model: skip the entry
        const values = [];
        for (let k = 0; k < size; k++) values.push(dv.getFloat32(j + 4 * k));
        const colorType = j + 4 * size + 2 <= b.length ? dv.getUint16(j + 4 * size) : 2;
        const model = modelRaw.trim();
        const rgb = toRgb(model, values);
        swatches.push({ name, group, model, values, type: ["global", "spot", "normal"][colorType] || "normal",
            rgb, hex: hex(rgb), id: (group ? group + "/" : "") + name });
    }
    return swatches;
}

// The selected swatches of a palette (ids from the panel), in palette order.
function selectedSwatches(palette, selectedIds) {
    if (!palette || !Array.isArray(selectedIds) || !selectedIds.length) return [];
    const want = new Set(selectedIds);
    return palette.swatches.filter((s) => want.has(s.id));
}

// How to create the swatch in InDesign: its original model and InDesign's
// value ranges (RGB 0–255, CMYK 0–100 %, LAB L 0–100 / a, b as-is, Gray → CMYK K).
function inDesignColor(swatch) {
    const v = swatch.values;
    if (swatch.model === "RGB") return { space: "RGB", values: v.map((x) => Math.round(x * 255)) };
    if (swatch.model === "CMYK") return { space: "CMYK", values: v.map((x) => Math.round(x * 1000) / 10) };
    if (swatch.model === "LAB") return { space: "LAB", values: [v[0] * 100, v[1], v[2]] };
    return { space: "CMYK", values: [0, 0, 0, Math.round((1 - v[0]) * 1000) / 10] };
}

module.exports = { parseASE, selectedSwatches, inDesignColor, toRgb, hex };
