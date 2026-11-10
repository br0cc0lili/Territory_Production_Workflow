// raster.js — image decode / encode for the node handlers (jimp, pure JS —
// no native modules, runs on Adobe I/O Runtime and locally).
//
//   decodeImage(bytes)      -> { width, height, data }  RGBA, 4 bytes per pixel
//   loadJimp(bytes)         -> Jimp image (resize / composite / crop)
//   encodePng(jimpImage)    -> Buffer

const { Jimp } = require("jimp");

const MAX_PIXELS = 60e6; // refuse absurd images before decoding them fully

async function loadJimp(bytes) {
    const img = await Jimp.read(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes));
    if (img.bitmap.width * img.bitmap.height > MAX_PIXELS) throw new Error(`image too large (${img.bitmap.width}×${img.bitmap.height})`);
    return img;
}

async function decodeImage(bytes) {
    const img = await loadJimp(bytes);
    const { width, height, data } = img.bitmap;
    return { width, height, data };
}

function encodePng(img) {
    return img.getBuffer("image/png");
}

function blankImage(width, height, rgba = 0x00000000) {
    return new Jimp({ width, height, color: rgba });
}

module.exports = { Jimp, loadJimp, decodeImage, encodePng, blankImage, MAX_PIXELS };
