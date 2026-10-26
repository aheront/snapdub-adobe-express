// SnapDub Clips for Adobe Express: sign in with SnapDub, pick one of your videos, and put any of its
// finished clips on the page with a click or by dragging it. Three screens - sign in, videos, clips -
// drawn from scratch on every change; the panel resets often (switching panels, resizing), so the
// only state kept across reloads is the sign-in (snapdub.js).
import addOnUISdk from "https://new.express.adobe.com/static/add-on-sdk/sdk.js";
import * as snapdub from "./snapdub.js";

// A clip's links are signed for an hour. Past this age the list is fetched again before a clip is
// downloaded, so a panel left open over lunch still adds clips.
const LINKS_FRESH_MS = 45 * 60_000;

const app = document.getElementById("app");
const toastEl = document.getElementById("toast");
const state = {
    view: "signin", account: null, videos: null, nextPage: null, loadingMore: false, moreError: false,
    video: null, clips: null, clipsAt: 0, busy: {}, error: null
};
// Watches the end of the video list and asks for the next page when it scrolls into view.
let moreObserver;

// ---- tiny DOM helper: never innerHTML for data, video and clip titles are user text ---------------

function h(tag, props = {}, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
        if (value == null || value === false) continue;
        if (key === "class") el.className = value;
        else if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
        else el.setAttribute(key, value === true ? "" : value);
    }
    for (const child of children.flat()) {
        if (child == null || child === false) continue;
        el.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return el;
}

function svg(markup) {
    const wrap = document.createElement("span");
    wrap.innerHTML = markup; // our own constant markup only
    return wrap.firstElementChild;
}

const LOGO = `<svg viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="8" fill="#C81E3A"/><path d="M11 10 19.5 16 11 22Z" fill="#fff"/><path d="M22 12.5a4.5 4.5 0 0 1 0 7" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round"/></svg>`;
const CHEVRON = `<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3 5 8l5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

let toastTimer;
function toast(message, { error = false } = {}) {
    toastEl.textContent = message;
    toastEl.className = error ? "toast toast--error" : "toast";
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toastEl.hidden = true), error ? 6000 : 4500);
}

function openSnapdub(path) {
    window.open(snapdub.snapdubLink(path), "_blank", "noopener");
}

function formatDuration(seconds) {
    const s = Math.round(seconds || 0);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function formatDate(iso) {
    try {
        return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
    } catch {
        return "";
    }
}

function signedOut() {
    Object.assign(state, { view: "signin", account: null, videos: null, video: null, clips: null, busy: {}, error: null });
    render();
}

// ---- data ----------------------------------------------------------------------------------------

// Any call can find the sign-in gone (revoked on snapdub.ai, or the refresh token expired): then the
// panel goes back to the sign-in screen instead of showing an error.
async function load(work) {
    state.error = null;
    try {
        await work();
    } catch (error) {
        if (error instanceof snapdub.SignedOut) return signedOut();
        state.error = error.message || "Something went wrong.";
    }
    render();
}

async function loadVideos() {
    Object.assign(state, { view: "videos", videos: null, nextPage: null, moreError: false, video: null, clips: null, error: null });
    render();
    await load(async () => {
        const [account, page] = await Promise.all([snapdub.whoami(), snapdub.listVideos(1)]);
        state.account = account;
        state.videos = page.videos || [];
        state.nextPage = page.next_page || null;
    });
}

// The next 20 older videos, appended under the ones already shown. A failure leaves a "Try again"
// at the end of the list instead of replacing it.
async function loadMoreVideos() {
    if (state.loadingMore || !state.nextPage || state.view !== "videos") return;
    state.loadingMore = true;
    state.moreError = false;
    renderMore();
    try {
        const page = await snapdub.listVideos(state.nextPage);
        state.videos = state.videos.concat(page.videos || []);
        state.nextPage = page.next_page || null;
        state.loadingMore = false;
        const scroll = document.scrollingElement.scrollTop;
        render();
        document.scrollingElement.scrollTop = scroll;
    } catch (error) {
        state.loadingMore = false;
        if (error instanceof snapdub.SignedOut) return signedOut();
        state.moreError = true;
        renderMore();
    }
}

async function openVideo(video) {
    Object.assign(state, { view: "clips", video, clips: null, error: null, busy: {} });
    render();
    await load(refreshClips);
}

async function refreshClips() {
    const result = await snapdub.listClips(state.video.video_id);
    state.clips = result.clips || [];
    state.clipsNote = result.note;
    state.clipsAt = Date.now();
}

// The clip with a download link that is still good, fetching the list again if the links are old.
async function clipBlob(clip, onProgress) {
    let current = clip;
    if (Date.now() - state.clipsAt > LINKS_FRESH_MS) {
        await refreshClips();
        current = state.clips.find(c => c.clip_id === clip.clip_id) || clip;
    }
    if (!current.download_url) throw new Error("This clip has no file yet.");
    return snapdub.downloadClip(current.download_url, onProgress);
}

// ---- actions -------------------------------------------------------------------------------------

async function signIn(button) {
    button.disabled = true;
    try {
        if (await snapdub.signIn(addOnUISdk.app.oauth)) return loadVideos();
    } catch (error) {
        toast(error.message || "Sign-in didn't work. Please try again.", { error: true });
    }
    button.disabled = false;
}

async function signOut() {
    await snapdub.signOut();
    signedOut();
}

// While the file downloads: a bar with the percentage. Once it is here and Express is placing it
// ("adding"): a spinner, since Express reports no progress of its own.
function busyOverlay(progress) {
    if (progress === "adding") return h("div", { class: "clip__busy" }, h("span", { class: "spinner spinner--light", "aria-hidden": "true" }), "Adding to page…");
    const percent = Math.round(progress * 100);
    return h(
        "div",
        { class: "clip__busy" },
        percent ? `Downloading ${percent}%` : "Downloading…",
        h("div", { class: "bar" }, h("span", { style: `width:${percent}%` }))
    );
}

// Redraws only the one card's overlay, so a running download doesn't rebuild the whole grid.
function setBusy(clipId, progress) {
    if (progress == null) delete state.busy[clipId];
    else state.busy[clipId] = progress;
    const card = app.querySelector(`[data-clip="${CSS.escape(clipId)}"]`);
    if (!card) return;
    const thumb = card.querySelector(".clip__thumb");
    thumb.querySelector(".clip__busy")?.remove();
    if (progress != null) thumb.append(busyOverlay(progress));
}

async function addClip(clip) {
    if (state.busy[clip.clip_id] != null) return;
    setBusy(clip.clip_id, 0);
    try {
        const blob = await clipBlob(clip, p => setBusy(clip.clip_id, p));
        setBusy(clip.clip_id, "adding");
        await addOnUISdk.app.document.addVideo(
            blob,
            { title: clip.title || "SnapDub clip", author: "SnapDub" },
            { nodeAddOnData: { snapdubClipId: clip.clip_id } }
        );
        toast("Added to your page. Let Express finish uploading it before you download or share the design.");
    } catch (error) {
        if (error instanceof snapdub.SignedOut) return signedOut();
        toast(`Couldn't add the clip. ${error?.message || "Please try again."}`, { error: true });
    } finally {
        setBusy(clip.clip_id, null);
    }
}

function enableDrag(card, clip) {
    try {
        addOnUISdk.app.enableDragToDocument(card, {
            previewCallback: () => new URL(clip.thumbnail_url || snapdub.snapdubLink("/icon.png")),
            completionCallback: async () => {
                const blob = await clipBlob(clip);
                return [{ blob, attributes: { title: clip.title || "SnapDub clip" }, importAddOnData: { nodeAddOnData: { snapdubClipId: clip.clip_id } } }];
            }
        });
    } catch {
        // Dragging isn't available here; a click still adds the clip.
    }
}

// ---- screens -------------------------------------------------------------------------------------

function brandRow(...extra) {
    return h("div", { class: "brand" }, svg(LOGO), h("h1", { class: "grow" }, "SnapDub Clips"), ...extra);
}

function signInScreen() {
    const button = h("button", { class: "btn", onclick: () => signIn(button) }, "Sign in with SnapDub");
    return h(
        "div",
        { class: "stack hero" },
        brandRow(),
        h("div", { class: "hero__art", "aria-hidden": "true" }, h("span"), h("span"), h("span")),
        h("h2", {}, "Your SnapDub clips, right in your design"),
        h("p", { class: "muted" }, "Sign in to see the clips SnapDub made from your videos. Click a clip or drag it onto the page to add it."),
        button,
        h(
            "p",
            { class: "small muted center" },
            "New to SnapDub? ",
            h("button", { class: "link", onclick: () => openSnapdub("/signup") }, "Create a free account"),
            ", then sign in here."
        )
    );
}

function errorBox(message, retry) {
    return h("div", { class: "error", role: "alert" }, h("p", {}, message), h("button", { class: "btn btn--quiet", onclick: retry }, "Try again"));
}

function footer() {
    const who = state.account ? `${state.account.account} · ${state.account.plan}` : "";
    return h(
        "div",
        { class: "footer row small" },
        h("span", { class: "grow ellipsis muted", title: who }, who),
        h("button", { class: "link", onclick: signOut }, "Sign out")
    );
}

function videoLine(video) {
    const ready = video.clips_ready || 0;
    if (ready) return `${ready} clip${ready === 1 ? "" : "s"} · ${formatDate(video.created_at)}`;
    if (video.status === "failed") return "Failed";
    if (video.status === "done") return "No clips";
    const status = video.status.charAt(0).toUpperCase() + video.status.slice(1);
    return video.progress_percent ? `${status} · ${video.progress_percent}%` : status;
}

function videosScreen() {
    if (state.error) return h("div", { class: "stack" }, brandRow(), errorBox(state.error, loadVideos), footer());
    if (!state.videos) {
        return h("div", { class: "stack" }, brandRow(), ...[0, 1, 2, 3].map(() => h("div", { class: "skeleton", style: "height:52px" })));
    }

    const refresh = h("button", { class: "link small", onclick: loadVideos }, "Refresh");
    const newClips = h("button", { class: "btn btn--quiet", onclick: () => openSnapdub("/videos/new") }, "Make clips from a new video");
    if (state.videos.length === 0) {
        return h(
            "div",
            { class: "stack" },
            brandRow(refresh),
            h("p", { class: "muted" }, "No videos yet. Paste a link or upload a video on snapdub.ai, and its clips show up here."),
            newClips,
            footer()
        );
    }

    const rows = state.videos.map(video => {
        const ready = video.clips_ready || 0;
        return h(
            "li",
            {},
            h(
                "button",
                { class: "video", disabled: ready === 0, onclick: () => openVideo(video) },
                h(
                    "span",
                    { class: "grow" },
                    h("span", { class: "ellipsis", style: "display:block;font-weight:700" }, video.title || "Untitled video"),
                    h("span", { class: "small muted" }, videoLine(video))
                ),
                h("span", { class: ready ? "video__count" : "video__count video__count--none", "aria-hidden": "true" }, String(ready))
            )
        );
    });

    return h(
        "div",
        { class: "stack" },
        brandRow(refresh),
        h("p", { class: "small muted" }, "Pick a video to see its clips."),
        h("ul", { class: "videos" }, rows),
        h("div", { id: "more", class: "more" }, moreContent()),
        newClips,
        footer()
    );
}

function moreContent() {
    if (state.loadingMore) return [h("span", { class: "spinner", "aria-hidden": "true" }), h("span", { class: "small muted" }, "Loading older videos…")];
    if (state.moreError) return h("button", { class: "link small", onclick: loadMoreVideos }, "Couldn't load more. Try again");
    return [];
}

function renderMore() {
    document.getElementById("more")?.replaceChildren(...[moreContent()].flat());
}

function clipsScreen() {
    const back = h("button", { class: "back", onclick: loadVideos }, svg(CHEVRON), "All videos");
    const title = h("h2", { class: "ellipsis" }, state.video.title || "Untitled video");
    if (state.error) return h("div", { class: "stack" }, back, title, errorBox(state.error, () => openVideo(state.video)), footer());
    if (!state.clips) {
        return h(
            "div",
            { class: "stack" },
            back,
            title,
            h("div", { class: "clips" }, ...[0, 1, 2, 3].map(() => h("div", { class: "skeleton", style: "aspect-ratio:9/16" })))
        );
    }
    if (state.clips.length === 0) {
        return h("div", { class: "stack" }, back, title, h("p", { class: "muted" }, state.clipsNote || "This video has no clips."), footer());
    }

    const cards = state.clips.map(clip => {
        const thumb = h(
            "div",
            { class: "clip__thumb" },
            clip.thumbnail_url ? h("img", { src: clip.thumbnail_url, alt: "", loading: "lazy", draggable: "false" }) : null,
            clip.virality_score != null ? h("span", { class: "clip__score", title: "Virality score" }, String(clip.virality_score)) : null,
            clip.duration_seconds ? h("span", { class: "clip__badge" }, formatDuration(clip.duration_seconds)) : null,
            state.busy[clip.clip_id] != null ? busyOverlay(state.busy[clip.clip_id]) : null
        );
        const card = h(
            "button",
            { class: "clip", "data-clip": clip.clip_id, title: "Click to add, or drag onto the page", onclick: () => addClip(clip) },
            thumb,
            h("span", { class: "clip__title" }, clip.title || "Clip")
        );
        enableDrag(card, clip);
        return card;
    });

    return h(
        "div",
        { class: "stack" },
        back,
        title,
        h("p", { class: "small muted" }, "Click a clip to add it to your page, or drag it where you want it."),
        h("div", { class: "clips" }, cards),
        footer()
    );
}

function render() {
    const screen = state.view === "signin" ? signInScreen() : state.view === "clips" ? clipsScreen() : videosScreen();
    app.replaceChildren(screen);

    moreObserver?.disconnect();
    const sentinel = document.getElementById("more");
    if (sentinel && state.nextPage) {
        moreObserver = new IntersectionObserver(entries => entries.some(e => e.isIntersecting) && loadMoreVideos(), { rootMargin: "200px" });
        moreObserver.observe(sentinel);
    }
}

// ---- start ---------------------------------------------------------------------------------------

function applyTheme(theme) {
    document.documentElement.dataset.theme = theme === "dark" ? "dark" : "light";
}

addOnUISdk.ready.then(() => {
    applyTheme(addOnUISdk.app.ui.theme);
    addOnUISdk.app.on("themechange", event => applyTheme(event.theme));
    addOnUISdk.app.on("dragend", event => {
        if (event.dropCancelled && event.dropCancelReason && !/cancel/i.test(event.dropCancelReason)) {
            toast("Couldn't add that clip. Try clicking it instead.", { error: true });
        }
    });

    if (snapdub.isSignedIn()) loadVideos();
    else render();
});
