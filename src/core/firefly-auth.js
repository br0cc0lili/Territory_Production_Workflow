// firefly-auth.js — Firefly credentials for the Image Extension worker.
//
// ADAPTED from territory-app actions/image-extension/auth.js @ b67bcb2: same
// scope check and token flow, calling @adobe/aio-lib-core-auth directly (the
// library behind Core.AuthClient in @adobe/aio-sdk) instead of the whole SDK.
//
// The worker action is annotated `include-ims-credentials: true`
// (app.config.yaml): App Builder injects the workspace's OAuth
// Server-to-Server credential as args.__ims_oauth_s2s. ONLY that injected
// object is read — never workflow inputs/parameters, so a workflow cannot
// supply or override credentials. The token is cached by the library (5 min).
//
// Never log or return the credential or the token.

const REQUIRED_FIREFLY_SCOPES = ["firefly_api", "ff_apis"];

function loadAuthLib(lib) {
    return lib || require("@adobe/aio-lib-core-auth");
}

// What src/core/firefly-client.js needs: { clientId, getAccessToken }.
//   args: the worker's main(args) — only args.__ims_oauth_s2s is used
//   lib:  injectable @adobe/aio-lib-core-auth (tests)
function getFireflyAuth(args, lib) {
    const auth = loadAuthLib(lib);
    const injected = args && args.__ims_oauth_s2s;
    if (!injected || typeof injected !== "object") {
        throw new Error("Firefly credential missing: the worker needs the include-ims-credentials annotation and an OAuth Server-to-Server credential with Firefly Services in its workspace");
    }
    const resolved = auth.resolveCredentials({ __ims_oauth_s2s: injected });
    const scopes = resolved.credentials.scopes || [];
    const missing = scopes.length ? REQUIRED_FIREFLY_SCOPES.filter((s) => !scopes.includes(s)) : [];
    if (missing.length) throw new Error(`OAuth Server-to-Server credential lacks Firefly scope(s): ${missing.join(", ")}`);
    return {
        clientId: resolved.credentials.clientId,
        getAccessToken: async () => {
            const token = await auth.generateAccessToken(resolved);
            if (!token || !token.access_token) throw new Error("IMS returned no access token");
            return token.access_token;
        },
    };
}

module.exports = { getFireflyAuth, REQUIRED_FIREFLY_SCOPES };
