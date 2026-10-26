// Talking to SnapDub: sign in (OAuth 2.0 code + PKCE through Adobe's own popup), keep the tokens,
// and call the SnapDub MCP server at /mcp. The panel is a public client, so the token exchange
// runs here in the browser; snapdub.ai allows this add-on's origin on /oauth/token, /oauth/revoke
// and /mcp (config/initializers/cors.rb in video-cutter).
import { CLIENT_ID, SCOPE, SNAPDUB_URL } from "./config.js";

const SESSION_KEY = "snapdub.session";
// Refresh a little before the hour is up, so a call never leaves with a token about to die.
const EXPIRY_MARGIN_MS = 60_000;

export class SignedOut extends Error {}

// ---- tokens --------------------------------------------------------------------------------------

function readSession() {
    try {
        return JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
    } catch {
        return null;
    }
}

function writeSession(session) {
    try {
        if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
        else localStorage.removeItem(SESSION_KEY);
    } catch {
        // Storage can be blocked; the panel then just signs in again next time.
    }
}

export function isSignedIn() {
    return Boolean(readSession()?.refresh_token || readSession()?.access_token);
}

function sessionFrom(tokenResponse) {
    return {
        access_token: tokenResponse.access_token,
        refresh_token: tokenResponse.refresh_token,
        expires_at: Date.now() + (tokenResponse.expires_in || 3600) * 1000
    };
}

async function postForm(path, fields) {
    return fetch(`${SNAPDUB_URL}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: new URLSearchParams(fields)
    });
}

// ---- PKCE ----------------------------------------------------------------------------------------

function base64url(bytes) {
    let text = "";
    bytes.forEach(b => (text += String.fromCharCode(b)));
    return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function pkcePair() {
    const verifier = base64url(crypto.getRandomValues(new Uint8Array(48)));
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    return { verifier, challenge: base64url(new Uint8Array(digest)) };
}

// ---- sign in and out -----------------------------------------------------------------------------

// Opens Adobe's sign-in popup on snapdub.ai/oauth/authorize. Our own login page, Google sign-in and
// sign-up all work inside it. Resolves true when signed in, false when the person closed the popup.
export async function signIn(oauth) {
    const { verifier, challenge } = await pkcePair();
    const { code, redirectUri, result } = await oauth.authorize({
        authorizationUrl: `${SNAPDUB_URL}/oauth/authorize`,
        clientId: CLIENT_ID,
        scope: SCOPE,
        codeChallenge: challenge
    });
    if (result?.status !== "SUCCESS" || !code) {
        if (result?.status === "POPUP_BLOCKED") throw new Error("The sign-in window was blocked. Allow pop-ups and try again.");
        return false;
    }

    const response = await postForm("/oauth/token", {
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: CLIENT_ID,
        code_verifier: verifier
    });
    if (!response.ok) throw new Error("SnapDub didn't finish the sign-in. Please try again.");
    writeSession(sessionFrom(await response.json()));
    return true;
}

export async function signOut() {
    const session = readSession();
    writeSession(null);
    const token = session?.refresh_token || session?.access_token;
    if (!token) return;
    try {
        await postForm("/oauth/revoke", { token, client_id: CLIENT_ID });
    } catch {
        // Signed out here either way; the token dies on its own.
    }
}

async function refresh(session) {
    if (!session?.refresh_token) return null;
    const response = await postForm("/oauth/token", {
        grant_type: "refresh_token",
        refresh_token: session.refresh_token,
        client_id: CLIENT_ID
    });
    if (!response.ok) return null;
    const next = sessionFrom(await response.json());
    next.refresh_token ||= session.refresh_token;
    writeSession(next);
    return next;
}

async function accessToken({ force = false } = {}) {
    let session = readSession();
    if (!session) throw new SignedOut();
    if (force || !session.access_token || Date.now() > session.expires_at - EXPIRY_MARGIN_MS) {
        session = await refresh(session);
        if (!session) {
            writeSession(null);
            throw new SignedOut();
        }
    }
    return session.access_token;
}

// ---- the MCP tools the panel uses ----------------------------------------------------------------

let rpcId = 0;

async function callTool(name, args = {}, retried = false) {
    const token = await accessToken({ force: retried });
    const response = await fetch(`${SNAPDUB_URL}/mcp`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream"
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } })
    });
    if (response.status === 401) {
        if (!retried) return callTool(name, args, true);
        writeSession(null);
        throw new SignedOut();
    }
    if (response.status === 429) throw new Error("Too many requests. Wait a moment and try again.");
    if (!response.ok) throw new Error("SnapDub didn't answer. Please try again.");

    const body = await response.json();
    if (body.error) throw new Error(body.error.message || "Something went wrong.");
    const result = body.result || {};
    if (result.isError) throw new Error(result.content?.[0]?.text || "Something went wrong.");
    return result.structuredContent || JSON.parse(result.content?.[0]?.text || "{}");
}

export const whoami = () => callTool("whoami");
// One page of 20 videos, newest first; next_page is set while older ones remain. The first page is
// asked for with no arguments, the way every SnapDub version answers it.
export const listVideos = (page = 1) => callTool("list_videos", page > 1 ? { page } : {});
export const listClips = videoId => callTool("list_clips", { video_id: videoId });

// Downloads a finished clip as a Blob Express accepts, reporting progress as 0..1 when the size is
// known. The link is a signed storage URL, so no token goes with it.
export async function downloadClip(url, onProgress) {
    const response = await fetch(url);
    if (!response.ok) throw new Error("Couldn't download the clip.");
    const total = Number(response.headers.get("Content-Length")) || 0;
    let blob;
    if (total && response.body && onProgress) {
        const reader = response.body.getReader();
        const parts = [];
        let received = 0;
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            parts.push(value);
            received += value.length;
            onProgress(received / total);
        }
        blob = new Blob(parts, { type: response.headers.get("Content-Type") || "" });
    } else {
        blob = await response.blob();
    }
    // A download link is served as an attachment, which can come back without a video type, and
    // Express refuses a Blob whose type it doesn't know. Every finished clip is an mp4.
    return blob.type.startsWith("video/") ? blob : new Blob([blob], { type: "video/mp4" });
}

export const snapdubLink = path => `${SNAPDUB_URL}${path}`;
