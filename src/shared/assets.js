// assets.js — asset I/O shared by the node handlers (platform-neutral core;
// the App Builder file store is injected, never imported at module load).
//
//   fetchAsset(url)          download an input asset (HTTPS only, size-limited)
//   createFilesStore()       write an output asset to App Builder Files and
//                            return a presigned HTTPS URL (FFCPE image outputs
//                            must be URLs, not bytes)
//
// Inputs and parameters from a workflow are untrusted: URLs are checked
// before fetching, redirects must stay on HTTPS and bodies are size-capped.
// Presigned URLs are never logged (they grant read access).

const DEFAULT_MAX_BYTES = 80 * 1024 * 1024; // 80 MB per input asset
const DEFAULT_TIMEOUT_MS = 60000;

class AssetError extends Error {}

function assertHttpsUrl(url, what) {
    let u;
    try {
        u = new URL(String(url));
    } catch (e) {
        throw new AssetError(`${what}: not a valid URL`);
    }
    if (u.protocol !== "https:") throw new AssetError(`${what}: URL must use HTTPS`);
    return u;
}

// Downloads an asset. Returns a Buffer.
//   opts.fetch      injectable fetch (tests); defaults to the global fetch
//   opts.maxBytes   size cap
//   opts.what       label for error messages (port name), never the URL
async function fetchAsset(url, opts = {}) {
    const what = opts.what || "asset";
    assertHttpsUrl(url, what);
    const doFetch = opts.fetch || globalThis.fetch;
    const maxBytes = opts.maxBytes || DEFAULT_MAX_BYTES;
    const signal = typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(opts.timeoutMs || DEFAULT_TIMEOUT_MS) : undefined;
    const res = await doFetch(String(url), { method: "GET", redirect: "follow", signal });
    if (!res.ok) throw new AssetError(`${what}: download failed (HTTP ${res.status})`);
    if (res.url) assertHttpsUrl(res.url, `${what} (after redirect)`);
    const declared = Number(res.headers && res.headers.get && res.headers.get("content-length"));
    if (declared > maxBytes) throw new AssetError(`${what}: ${declared} bytes exceeds the ${maxBytes}-byte limit`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) throw new AssetError(`${what}: ${buf.length} bytes exceeds the ${maxBytes}-byte limit`);
    if (!buf.length) throw new AssetError(`${what}: empty file`);
    return buf;
}

// Output store backed by App Builder Files (@adobe/aio-lib-files).
//   put(path, bytes) -> presigned HTTPS URL (read-only, expirySeconds)
//   opts.init  injectable files init (tests)
function createFilesStore(opts = {}) {
    const expirySeconds = opts.expirySeconds || 18000; // 5 h, like the SDK examples
    let filesPromise = null;
    function files() {
        if (!filesPromise) {
            const init = opts.init || require("@adobe/aio-lib-files").init;
            filesPromise = init();
        }
        return filesPromise;
    }
    return {
        async put(remotePath, bytes) {
            if (!/^public\/[A-Za-z0-9._\-/]+$/.test(remotePath) || remotePath.includes("..")) {
                throw new AssetError("invalid output path");
            }
            const f = await files();
            await f.write(remotePath, bytes);
            return f.generatePresignURL(remotePath, { expiryInSeconds: expirySeconds, permissions: "r", urlType: "external" });
        },
    };
}

module.exports = { fetchAsset, createFilesStore, assertHttpsUrl, AssetError, DEFAULT_MAX_BYTES };
