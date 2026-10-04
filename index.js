const MODULE = "outfitViewer";
const DB_NAME = "outfit-viewer";
const DB_STORE = "handles";
const IMAGE_EXT = /\.(png|jpe?g|webp|gif|avif)$/i;

const defaults = {
    autoSwitch: true,
    // Only my own messages switch the outfit; the bot's are ignored.
    onlyUserMessages: false,
    showDescription: true,
    // Folder name under SillyTavern's data/<user>/user/images/. Survives reloads, unlike the browser picker.
    serverFolder: "outfits",
    // Character pictures, just for looking at: never switched by messages.
    characterFolder: "characters",
    // Which list the panel shows: "outfit" or "character".
    mode: "outfit",
    // The last image shown in each mode, shown again on launch or whenever there's nothing else.
    last: { outfit: null, character: null },
    width: 320,
    visible: true,
};

const ctx = () => SillyTavern.getContext();

// Two lists of images: outfits (switched by messages) and characters (picked by hand).
const views = {
    outfit: { items: [], current: null, label: "" },
    character: { items: [], current: null, label: "" },
};
let pendingHandle = null;

const characterMode = () => settings().mode === "character";
const modeKey = () => (characterMode() ? "character" : "outfit");
const view = () => views[modeKey()];
const currentItem = () => view().items.find((o) => o.name === view().current);

function settings() {
    const store = ctx().extensionSettings;
    // Fill in missing defaults in place; replacing the object would orphan earlier references.
    store[MODULE] ??= {};
    for (const [key, value] of Object.entries(defaults)) {
        if (store[MODULE][key] === undefined) store[MODULE][key] = structuredClone(value);
    }
    // Older versions had a separate lock, an Enabled box and a user-message box.
    const s = store[MODULE];
    if (s.locked) s.autoSwitch = false;
    delete s.locked;
    delete s.enabled;
    delete s.scanUserMessages;
    return store[MODULE];
}

// ---------- persisting the folder handle (Chrome/Edge) ----------

function openDb() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(DB_STORE);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function dbGet(key) {
    const db = await openDb();
    return new Promise((resolve) => {
        const req = db.transaction(DB_STORE).objectStore(DB_STORE).get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(undefined);
    });
}

async function dbSet(key, value) {
    const db = await openDb();
    return new Promise((resolve) => {
        const tx = db.transaction(DB_STORE, "readwrite");
        tx.objectStore(DB_STORE).put(value, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
    });
}

// ---------- outfit names ----------

// Generated images keep their prompt in a PNG text chunk; the outfit name is the first
// word(s) of the line after the style tags, e.g. "**Witch <weight[1.1]:cosplay>.**".
// Returns the generation prompt stored in a PNG's text chunks (SwarmUI JSON or A1111 plain text).
function promptFromPng(bytes) {
    const buf = new Uint8Array(bytes);
    if (buf[0] !== 0x89 || buf[1] !== 0x50) return null;
    const view = new DataView(buf.buffer, buf.byteOffset);
    const decoder = new TextDecoder();
    let pos = 8;
    while (pos + 8 <= buf.length) {
        const len = view.getUint32(pos);
        const type = decoder.decode(buf.subarray(pos + 4, pos + 8));
        if (type === "IDAT" || type === "IEND") break;
        if (type === "tEXt" || type === "iTXt") {
            const data = decoder.decode(buf.subarray(pos + 8, pos + 8 + len));
            let prompt = data.slice(data.indexOf("\0") + 1);
            try {
                const json = JSON.parse(prompt);
                prompt =
                    json?.sui_image_params?.prompt ?? json?.prompt ?? prompt;
            } catch {
                prompt = prompt.split("\nNegative prompt:")[0];
            }
            if (typeof prompt === "string" && prompt.trim()) return prompt;
        }
        pos += 12 + len;
    }
    return null;
}

// The outfit description is everything after the **title**; older prompts have an unbolded
// "Title <weight...>." at the start of the second line instead.
function descriptionFromPrompt(prompt) {
    if (!prompt) return "";
    const bold = prompt.match(/\*\*[^*]+\*\*/);
    if (bold) return prompt.slice(bold.index + bold[0].length).trim();
    const line = prompt.split("\n").slice(1).join("\n");
    const plain = line.match(/^[^\n.]+?(?:<[^>]*>)?\s*\.\s*/);
    return (plain ? line.slice(plain[0].length) : line).trim();
}

async function nameFromPngMetadata(file) {
    if (!/\.png$/i.test(file.name)) return null;
    const prompt = promptFromPng(await file.arrayBuffer());
    const match = prompt?.match(
        /\n\**\s*([A-Z][A-Za-z]*(?: [a-z]+)?)\s*(?:<|\.|\*)/,
    );
    return match ? match[1] : null;
}

// Description of an outfit, read from its image the first time it's shown, then cached.
async function descriptionOf(outfit) {
    const image = outfit.images[outfit.index];
    if (image.description !== undefined) return image.description;
    try {
        const response = await fetch(image.url);
        image.description = descriptionFromPrompt(
            promptFromPng(await response.arrayBuffer()),
        );
    } catch (err) {
        console.warn("[Outfit Viewer] could not read description", err);
        image.description = "";
    }
    return image.description;
}

async function outfitName(file) {
    const stem = file.name.replace(IMAGE_EXT, "");
    // Files straight out of an image generator have long auto-generated names.
    if (/masterpiece|^\d{5,}-/i.test(stem)) {
        const fromMeta = await nameFromPngMetadata(file);
        if (fromMeta) return fromMeta;
    }
    return stem;
}

// ---------- loading a folder ----------

function setItems(kind, entries, label) {
    views[kind].items.forEach((o) =>
        o.images.forEach(
            (i) => i.url.startsWith("blob:") && URL.revokeObjectURL(i.url),
        ),
    );
    const byName = new Map();
    for (const entry of entries) {
        const name =
            entry.name.replace(/\s*\([^()]*\)\s*$/, "").trim() || entry.name;
        const urls = entry.urls;
        let outfit = byName.get(name.toLowerCase());
        if (!outfit) {
            // "Fluffy witch, Paw witch" -> shown as "Fluffy witch", triggered by either key.
            const keys = name
                .split(",")
                .map((k) => k.trim())
                .filter(Boolean);
            outfit = {
                name,
                label: keys[0] ?? name,
                keys,
                images: [],
                index: 0,
            };
            byName.set(name.toLowerCase(), outfit);
        }
        outfit.images.push(...urls.map((url) => ({ url })));
    }
    const v = views[kind];
    v.items = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
    v.label = label;
    renderStatus();
    if (kind === "outfit") return restoreForChat();
    // Characters: keep the one being looked at if it's still there.
    if (!v.items.some((o) => o.name === v.current)) v.current = null;
    if (characterMode()) show(v.current);
}

async function loadFiles(files, label) {
    const entries = [];
    for (const file of files) {
        if (!IMAGE_EXT.test(file.name)) continue;
        entries.push({
            name: await outfitName(file),
            urls: [URL.createObjectURL(file)],
        });
    }
    setItems("outfit", entries, label);
}

async function loadFromServer(folder, kind = "outfit") {
    // Cache-bust so an image replaced under the same name shows its new version.
    const stamp = Date.now();
    const urlOf = (file) =>
        `user/images/${encodeURIComponent(folder)}/${file.split("/").map(encodeURIComponent).join("/")}?v=${stamp}`;
    try {
        let entries;
        const plugin = await fetch(
            `/api/plugins/outfit-viewer/list?folder=${encodeURIComponent(folder)}`,
            {
                headers: ctx().getRequestHeaders(),
            },
        );
        if (plugin.ok) {
            entries = (await plugin.json()).map((o) => ({
                name: o.name,
                urls: o.files.map(urlOf),
            }));
        } else {
            // No server plugin: flat folder only, one image per outfit.
            const response = await fetch("/api/images/list", {
                method: "POST",
                headers: ctx().getRequestHeaders(),
                body: JSON.stringify({
                    folder,
                    sortField: "name",
                    sortOrder: "asc",
                    type: 1,
                }),
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            entries = (await response.json())
                .filter((f) => IMAGE_EXT.test(f))
                .map((f) => ({
                    name: f.replace(IMAGE_EXT, ""),
                    urls: [urlOf(f)],
                }));
        }
        if (kind === "outfit") pendingHandle = null;
        setItems(kind, entries, `user/images/${folder}`);
    } catch (err) {
        console.error("[Outfit Viewer]", err);
        $("#outfit_viewer_status").text(
            `Couldn't load user/images/${folder}: ${err.message}`,
        );
    }
}

async function loadFromHandle(handle) {
    const files = [];
    for await (const entry of handle.values()) {
        if (entry.kind === "file") files.push(await entry.getFile());
    }
    await loadFiles(files, handle.name);
}

async function pickFolder() {
    if (window.showDirectoryPicker) {
        try {
            const handle = await window.showDirectoryPicker({
                id: "outfit-viewer",
                mode: "read",
            });
            await dbSet("folder", handle);
            pendingHandle = null;
            await loadFromHandle(handle);
        } catch (err) {
            if (err.name !== "AbortError")
                console.error("[Outfit Viewer]", err);
        }
        return;
    }
    // Firefox fallback: no persistent handle, re-pick each session.
    $("#outfit_viewer_file_input").trigger("click");
}

async function reconnect() {
    if (!pendingHandle) return;
    if (
        (await pendingHandle.requestPermission({ mode: "read" })) === "granted"
    ) {
        const handle = pendingHandle;
        pendingHandle = null;
        await loadFromHandle(handle);
    }
}

// Re-read the current folder so renamed or newly added images show up.
async function refresh() {
    const icon = $("#outfit_viewer_refresh").addClass("fa-spin");
    try {
        if (characterMode()) {
            const folder = settings().characterFolder.trim();
            if (folder) await loadFromServer(folder, "character");
            return;
        }
        const serverFolder = settings().serverFolder.trim();
        if (serverFolder) return await loadFromServer(serverFolder);
        const handle = window.showDirectoryPicker
            ? await dbGet("folder")
            : null;
        if (
            handle &&
            (await handle.requestPermission({ mode: "read" })) === "granted"
        ) {
            pendingHandle = null;
            return await loadFromHandle(handle);
        }
        // A folder picked through the plain file input can't be re-read; pick it again.
        await pickFolder();
    } finally {
        icon.removeClass("fa-spin");
    }
}

async function restoreFolder() {
    const characterFolder = settings().characterFolder.trim();
    if (characterFolder) await loadFromServer(characterFolder, "character");
    const serverFolder = settings().serverFolder.trim();
    if (serverFolder) return loadFromServer(serverFolder);
    if (!window.showDirectoryPicker) return renderStatus();
    const handle = await dbGet("folder");
    if (!handle) return renderStatus();
    const perm = await handle.queryPermission({ mode: "read" });
    if (perm === "granted") return loadFromHandle(handle);
    // Browsers only re-grant access after a click.
    pendingHandle = handle;
    renderStatus();
}

// ---------- showing an outfit ----------

function randomIndex(outfit) {
    const n = outfit.images.length;
    if (n < 2) return 0;
    const pick = Math.floor(Math.random() * (n - 1));
    return pick >= outfit.index ? pick + 1 : pick;
}

// Step through the current outfit's images in order.
function cycleImage(delta) {
    const outfit = currentItem();
    if (!outfit || outfit.images.length < 2) return;
    outfit.index =
        (outfit.index + delta + outfit.images.length) % outfit.images.length;
    renderImage(outfit);
}

// Read the text chunks of a PNG (tEXt, zTXt, iTXt), like chatbot-tools/image_prompt.py.
async function pngTextChunks(src) {
    const buf = new Uint8Array(await (await fetch(src)).arrayBuffer());
    const view = new DataView(buf.buffer);
    const latin = new TextDecoder("latin1");
    const utf8 = new TextDecoder("utf-8");
    const inflate = async (bytes) =>
        new Uint8Array(
            await new Response(
                new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate")),
            ).arrayBuffer(),
        );
    const chunks = {};
    let pos = 8;
    while (pos + 8 <= buf.length) {
        const length = view.getUint32(pos);
        const type = latin.decode(buf.subarray(pos + 4, pos + 8));
        const body = buf.subarray(pos + 8, pos + 8 + length);
        pos += 12 + length;
        if (type === "IEND") break;
        if (!["tEXt", "zTXt", "iTXt"].includes(type)) continue;
        const nul = body.indexOf(0);
        const key = latin.decode(body.subarray(0, nul));
        let rest = body.subarray(nul + 1);
        try {
            if (type === "tEXt") {
                // SwarmUI and A1111 write UTF-8 here even though the spec says latin-1.
                chunks[key] = utf8.decode(rest);
            } else if (type === "zTXt") {
                chunks[key] = utf8.decode(await inflate(rest.subarray(1)));
            } else {
                const compressed = rest[0];
                rest = rest.subarray(2);
                rest = rest.subarray(rest.indexOf(0) + 1); // language
                rest = rest.subarray(rest.indexOf(0) + 1); // translated keyword
                chunks[key] = utf8.decode(compressed ? await inflate(rest) : rest);
            }
        } catch {
            // Skip a chunk we can't decode.
        }
    }
    return chunks;
}

// Pull the prompt and negative prompt out of SwarmUI JSON or A1111 plain text.
async function readPrompts(src) {
    try {
        const chunks = await pngTextChunks(src);
        const raw = chunks.parameters || chunks.prompt || "";
        try {
            const parsed = JSON.parse(raw);
            const params = parsed.sui_image_params || parsed;
            return {
                // SwarmUI keeps what was typed (with <comment:...> etc.) in original_prompt.
                prompt:
                    parsed.sui_extra_data?.original_prompt ||
                    (typeof params.prompt === "string" ? params.prompt : ""),
                negative:
                    params.negativeprompt || params.negative_prompt || params.negativePrompt || "",
            };
        } catch {
            const [prompt, after = ""] = raw.split("\nNegative prompt:");
            return {
                prompt: prompt.trim(),
                negative: after.split(/\n(?=Steps: )/)[0].trim(),
            };
        }
    } catch {
        return { prompt: "", negative: "" };
    }
}

async function copyText(text, label) {
    try {
        await navigator.clipboard.writeText(text);
        toastr.success(`${label} copied`);
    } catch {
        toastr.error(`Couldn't copy the ${label.toLowerCase()}`);
    }
}

// Click the image for a full-screen view; click outside it or press Esc to close.
// Arrows and the scroll wheel keep browsing, same as over the panel.
function openLightbox() {
    const panelImg = document.getElementById("outfit_viewer_img");
    if (!panelImg.getAttribute("src")) return;
    const img = $("<img>");
    const bar = $('<div class="outfit_viewer_lightbox_bar"></div>');
    const box = $('<div id="outfit_viewer_lightbox"></div>').append(img, bar);

    // The buttons stay put; they're greyed out until the image's prompts are read.
    const button = (label) =>
        $('<button class="menu_button"></button>')
            .text(label)
            .prop("disabled", true)
            .on("click", function () {
                copyText($(this).data("text"), label);
            });
    const promptButton = button("Prompt");
    const negativeButton = button("Negative prompt");
    bar.append(promptButton, negativeButton);
    const setButton = (btn, text, pending) =>
        btn
            .data("text", text)
            .prop("disabled", !text)
            .attr("title", text || (pending ? "Reading prompt..." : "Not found in this image"));

    // Show whatever the panel shows, and reload its prompts.
    const refresh = () => {
        const src = panelImg.getAttribute("src");
        if (!src) return close();
        img.attr("src", src);
        setButton(promptButton, "", true);
        setButton(negativeButton, "", true);
        readPrompts(src).then(({ prompt, negative }) => {
            if (img.attr("src") !== src) return; // moved on meanwhile
            setButton(promptButton, prompt);
            setButton(negativeButton, negative);
        });
    };
    const observer = new MutationObserver(refresh);

    const onKey = (e) => {
        if (e.key === "Escape") {
            e.preventDefault();
            e.stopImmediatePropagation();
            close();
            return;
        }
        if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        if (e.key === "ArrowUp" || e.key === "ArrowDown")
            cycleImage(e.key === "ArrowDown" ? 1 : -1);
        else step(e.key === "ArrowRight" ? 1 : -1);
    };
    let lastWheel = 0;
    const onWheel = (e) => {
        e.preventDefault();
        const now = Date.now();
        if (now - lastWheel < 150) return;
        lastWheel = now;
        step(e.deltaY > 0 ? 1 : -1);
    };

    function close() {
        observer.disconnect();
        document.removeEventListener("keydown", onKey, true);
        box.remove();
    }

    box.on("click", (e) => {
        if (!$(e.target).closest(".outfit_viewer_lightbox_bar").length) close();
    });
    box[0].addEventListener("wheel", onWheel, { passive: false });
    // Capture phase, so SillyTavern's own arrow-key swiping doesn't also fire.
    document.addEventListener("keydown", onKey, true);
    observer.observe(panelImg, { attributes: true, attributeFilter: ["src"] });
    $("body").append(box);
    refresh();
}

function renderLock() {
    // The lock is the "Switch automatically" setting, shown on the panel.
    const locked = !settings().autoSwitch;
    $("#outfit_viewer_auto").prop("checked", !locked);
    $("#outfit_viewer_lock")
        // Characters are never switched by messages, so the lock means nothing there.
        .toggle(!characterMode())
        .toggleClass("fa-lock", locked)
        .toggleClass("fa-lock-open", !locked)
        .toggleClass("outfit_viewer_locked", locked)
        .attr("title", locked
            ? "Locked: messages won't switch the outfit. Click to unlock."
            : "Lock this outfit: stop messages from switching it");
}

function rememberLast(outfit) {
    const s = settings();
    const prev = s.last[modeKey()];
    if (prev?.name === outfit.name && prev?.index === outfit.index) return;
    s.last[modeKey()] = { name: outfit.name, index: outfit.index };
    ctx().saveSettingsDebounced();
}

function renderImage(outfit) {
    if (outfit) rememberLast(outfit);
    $("#outfit_viewer_img")
        .attr("src", outfit ? outfit.images[outfit.index].url : "")
        .toggle(!!outfit);
    const many = !!outfit && outfit.images.length > 1;
    // ⇅ steps through this outfit's images; ⇄ (single image) moves on to the next outfit.
    const noun = characterMode() ? "character" : "outfit";
    $("#outfit_viewer_cycle")
        .toggle(view().items.length > 1 || many)
        .toggleClass("fa-rotate-90", many)
        .attr("title", many ? `Next image of this ${noun} (↑/↓)` : `Next ${noun} (←/→)`);
    $("#outfit_viewer_count")
        .toggle(many)
        .text(many ? `${outfit.index + 1}/${outfit.images.length}` : "");
    renderDescription(outfit);
}

function findIn(items, name) {
    const wanted = String(name).toLowerCase();
    return (
        items.find((o) => o.name.toLowerCase() === wanted) ??
        items.find((o) => o.keys.some((k) => k.toLowerCase() === wanted))
    );
}

// The worn outfit belongs to the chat, so it's saved with it.
function saveOutfitForChat() {
    const { chatMetadata, saveMetadataDebounced } = ctx();
    if (chatMetadata) {
        chatMetadata[MODULE] = views.outfit.current;
        saveMetadataDebounced();
    }
}

function show(name, { persist = true } = {}) {
    const v = view();
    let item = findIn(v.items, name ?? "");
    // Arriving at an item starts on a random image; staying on it keeps the current one.
    if (item && item.name !== v.current) item.index = randomIndex(item);
    // Nothing to show: fall back to the last image shown in this mode, on the same picture.
    if (!item) {
        const last = settings().last[modeKey()];
        item = last ? findIn(v.items, last.name) : null;
        if (item && last.index < item.images.length) item.index = last.index;
    }
    v.current = item ? item.name : null;
    $("#outfit_viewer_empty")
        .text(characterMode() ? "No character" : "No outfit")
        .toggle(!item);
    $("#outfit_viewer_select").val(v.current ?? "");
    renderImage(item);
    if (persist && !characterMode()) saveOutfitForChat();
}

async function renderDescription(outfit) {
    const box = $("#outfit_viewer_desc");
    // Character pictures have no outfit description to show.
    if (!outfit || characterMode() || !settings().showDescription)
        return box.hide().text("");
    const text = await descriptionOf(outfit);
    // A later switch may have happened while this one was loading.
    if (view().current !== outfit.name) return;
    box.text(text).toggle(!!text).scrollTop(0);
}

function restoreForChat() {
    const saved = ctx().chatMetadata?.[MODULE];
    if (characterMode()) {
        views.outfit.current = findIn(views.outfit.items, saved ?? "")?.name ?? null;
        return;
    }
    show(saved ?? null, { persist: false });
}

// Flip the panel between the outfit list and the character list.
function setMode(mode) {
    settings().mode = mode;
    ctx().saveSettingsDebounced();
    renderSelect();
    renderLock();
    $("#outfit_viewer_mode")
        .toggleClass("fa-user", mode !== "character")
        .toggleClass("fa-shirt", mode === "character")
        .attr("title", mode === "character" ? "Show outfits" : "Show characters");
    $("#outfit_viewer_select").attr("title", mode === "character" ? "Pick a character" : "Pick an outfit");
    show(view().current, { persist: false });
}

function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Returns the outfit mentioned last in the text, preferring longer names at the same spot
// ("Fluffy witch" beats "witch").
function findOutfit(text) {
    let best = null;
    for (const o of views.outfit.items) {
        for (const key of o.keys) {
            const re = new RegExp(
                `(?<![\\w])${escapeRegex(key)}(?![\\w])`,
                "gi",
            );
            let m;
            while ((m = re.exec(text))) {
                const end = m.index + m[0].length;
                if (
                    !best ||
                    end > best.end ||
                    (end === best.end && key.length > best.len)
                ) {
                    best = { name: o.name, end, len: key.length };
                }
            }
        }
    }
    return best?.name ?? null;
}

function step(delta) {
    const items = view().items;
    if (!items.length) return;
    const index = items.findIndex((o) => o.name === view().current);
    const next =
        index === -1
            ? delta > 0
                ? 0
                : items.length - 1
            : (index + delta + items.length) % items.length;
    show(items[next].name);
}

// Status blocks (ID cards, duties, quests) can name outfits that aren't being worn right now.
// Also drops an unclosed block, which is what a message looks like mid-stream.
function stripStatusBlocks(text) {
    return text
        .replace(/<!--\s*GFX_START\s*-->[\s\S]*?<!--\s*GFX_END\s*-->/g, "")
        .replace(/<!--\s*GFX_START\s*-->[\s\S]*$/, "");
}

function scanText(text) {
    const s = settings();
    if (!s.autoSwitch || !text || !views.outfit.items.length) return;
    const found = findOutfit(stripStatusBlocks(text));
    if (!found || found === views.outfit.current) return;
    if (!characterMode()) return show(found);
    // Looking at a character: keep track of the outfit quietly, for when the panel flips back.
    views.outfit.current = found;
    saveOutfitForChat();
}

function scanMessage(id) {
    const msg = ctx().chat?.[id];
    if (!msg) return;
    const s = settings();
    if (!msg.is_user && s.onlyUserMessages) return;
    scanText(msg.mes);
}

// ---------- UI ----------

function renderSelect() {
    const { items, current } = view();
    const select = $("#outfit_viewer_select").empty();
    select.append(
        $("<option>")
            .val("")
            .text(items.length ? "— none —" : "— no folder —"),
    );
    // Show every key, so it's clear which words bring each outfit up.
    for (const o of items) {
        const count = o.images.length > 1 ? ` (${o.images.length})` : "";
        select.append(
            $("<option>")
                .val(o.name)
                .text(o.keys.join(", ") + count),
        );
    }
    select.val(current ?? "");
}

function renderStatus() {
    renderSelect();
    const status = $("#outfit_viewer_status");
    const reconnectBtn = $("#outfit_viewer_reconnect");
    const { outfit, character } = views;
    if (pendingHandle) {
        status.text(`Folder "${pendingHandle.name}" needs permission again.`);
        reconnectBtn.show();
    } else if (outfit.label) {
        status.text(`Folder "${outfit.label}": ${outfit.items.length} outfit(s).`);
        reconnectBtn.hide();
    } else {
        status.text("No folder selected.");
        reconnectBtn.hide();
    }
    $("#outfit_viewer_character_status").text(
        character.label
            ? `Folder "${character.label}": ${character.items.length} character(s).`
            : "No character folder loaded.",
    );
}

function applyLayout() {
    const s = settings();
    const panel = $("#outfit_viewer_panel")
        .css("width", `${s.width}px`)
        .toggle(s.visible);
    $("#outfit_viewer_toggle").toggle(!s.visible);
    if (s.position) {
        panel.css({
            left: `${s.position.left}px`,
            top: `${s.position.top}px`,
            right: "auto",
        });
        clampToViewport();
    } else {
        panel.css({ left: "", top: "", right: "" });
    }
}

function clampToViewport() {
    const panel = document.getElementById("outfit_viewer_panel");
    const s = settings();
    if (!panel || !s.position) return;
    const maxLeft = Math.max(0, window.innerWidth - panel.offsetWidth);
    const maxTop = Math.max(0, window.innerHeight - 40);
    s.position.left = Math.min(Math.max(0, s.position.left), maxLeft);
    s.position.top = Math.min(Math.max(0, s.position.top), maxTop);
    panel.style.left = `${s.position.left}px`;
    panel.style.top = `${s.position.top}px`;
}

// Drag by the header (anywhere but the dropdown and the close button).
function enableDragging() {
    const panel = document.getElementById("outfit_viewer_panel");
    const header = panel.querySelector(".outfit_viewer_header");
    header.addEventListener("pointerdown", (e) => {
        if (e.button !== 0 || e.target.closest("select, .outfit_viewer_icon"))
            return;
        e.preventDefault();
        const rect = panel.getBoundingClientRect();
        const offsetX = e.clientX - rect.left;
        const offsetY = e.clientY - rect.top;
        header.setPointerCapture(e.pointerId);
        panel.classList.add("dragging");
        const move = (ev) => {
            settings().position = {
                left: ev.clientX - offsetX,
                top: ev.clientY - offsetY,
            };
            panel.style.right = "auto";
            clampToViewport();
        };
        const up = () => {
            header.removeEventListener("pointermove", move);
            header.removeEventListener("pointerup", up);
            panel.classList.remove("dragging");
            ctx().saveSettingsDebounced();
        };
        header.addEventListener("pointermove", move);
        header.addEventListener("pointerup", up);
    });
    // Double-click the header to snap back to the default spot.
    header.addEventListener("dblclick", (e) => {
        if (e.target.closest("select, .outfit_viewer_icon")) return;
        delete settings().position;
        ctx().saveSettingsDebounced();
        applyLayout();
    });
    window.addEventListener("resize", clampToViewport);
}

// Scroll or arrow keys while the pointer is over the panel flip through outfits.
function enableBrowsing() {
    const panel = document.getElementById("outfit_viewer_panel");
    let hovering = false;
    let lastWheel = 0;
    panel.addEventListener("pointerenter", () => {
        hovering = true;
    });
    panel.addEventListener("pointerleave", () => {
        hovering = false;
    });
    panel.addEventListener(
        "wheel",
        (e) => {
            // Let the dropdown and the description box scroll normally.
            if (e.target.closest("select, #outfit_viewer_desc")) return;
            e.preventDefault();
            const now = Date.now();
            if (now - lastWheel < 150) return;
            lastWheel = now;
            step(e.deltaY > 0 ? 1 : -1);
        },
        { passive: false },
    );
    document.addEventListener(
        "keydown",
        (e) => {
            if (!hovering || !$(panel).is(":visible")) return;
            if (e.target.closest('input, textarea, [contenteditable="true"]'))
                return;
            if (
                !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(
                    e.key,
                )
            )
                return;
            // Capture phase, so SillyTavern's own arrow-key swiping doesn't also fire.
            e.preventDefault();
            e.stopImmediatePropagation();
            if (e.key === "ArrowUp" || e.key === "ArrowDown")
                cycleImage(e.key === "ArrowDown" ? 1 : -1);
            else step(e.key === "ArrowRight" ? 1 : -1);
        },
        true,
    );
}

function buildPanel() {
    const panel = $(`
        <div id="outfit_viewer_panel">
            <div class="outfit_viewer_header">
                <div class="outfit_viewer_grip fa-solid fa-grip-vertical" title="Drag to move · double-click to reset"></div>
                <select id="outfit_viewer_select" title="Pick an outfit"></select>
                <small id="outfit_viewer_count"></small>
                <div id="outfit_viewer_mode" class="outfit_viewer_icon fa-solid fa-user" title="Show characters"></div>
                <div id="outfit_viewer_lock" class="outfit_viewer_icon fa-solid fa-lock-open" title="Lock this outfit: stop messages from switching it"></div>
                <div id="outfit_viewer_cycle" class="outfit_viewer_icon fa-solid fa-arrow-right-arrow-left" title="Next outfit (←/→)"></div>
                <div id="outfit_viewer_refresh" class="outfit_viewer_icon fa-solid fa-rotate" title="Reload folder"></div>
                <div id="outfit_viewer_hide" class="outfit_viewer_icon fa-solid fa-xmark" title="Hide"></div>
            </div>
            <img id="outfit_viewer_img" alt="" />
            <div id="outfit_viewer_empty">No outfit</div>
            <div id="outfit_viewer_desc"></div>
        </div>
        <div id="outfit_viewer_toggle" class="fa-solid fa-shirt" title="Show outfit"></div>
    `);
    $("body").append(panel);
    $("#outfit_viewer_select").on("change", function () {
        show(this.value || null);
    });
    $("#outfit_viewer_refresh").on("click", refresh);
    $("#outfit_viewer_mode").on("click", () =>
        setMode(characterMode() ? "outfit" : "character"),
    );
    $("#outfit_viewer_lock").on("click", () => {
        settings().autoSwitch = !settings().autoSwitch;
        ctx().saveSettingsDebounced();
        renderLock();
    });
    renderLock();
    $("#outfit_viewer_cycle")
        .on("click", () => {
            const outfit = currentItem();
            if (outfit && outfit.images.length > 1) cycleImage(1);
            else step(1);
        })
        .hide();
    $("#outfit_viewer_img").on("click", openLightbox);
    $("#outfit_viewer_count").hide();
    $("#outfit_viewer_hide").on("click", () => {
        settings().visible = false;
        ctx().saveSettingsDebounced();
        applyLayout();
    });
    $("#outfit_viewer_toggle").on("click", () => {
        settings().visible = true;
        ctx().saveSettingsDebounced();
        applyLayout();
    });
    $("#outfit_viewer_empty").show();
    $("#outfit_viewer_img").hide().attr("draggable", "false");
    enableDragging();
    enableBrowsing();
}

function buildSettings() {
    const s = settings();
    const html = $(`
        <div class="outfit_viewer_settings">
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>Outfit Viewer</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <label class="checkbox_label"><input id="outfit_viewer_auto" type="checkbox"> Switch automatically when an outfit is mentioned</label>
                    <label class="checkbox_label"><input id="outfit_viewer_only_user" type="checkbox"> Only my own messages switch the outfit</label>
                    <label class="checkbox_label"><input id="outfit_viewer_desc_toggle" type="checkbox"> Show the outfit description under the image</label>
                    <label>Panel width: <span id="outfit_viewer_width_val"></span>px
                        <input id="outfit_viewer_width" type="range" min="150" max="700" step="10">
                    </label>
                    <label for="outfit_viewer_server_folder">SillyTavern image folder (in data/default-user/user/images/):</label>
                    <div class="flex-container">
                        <input id="outfit_viewer_server_folder" class="text_pole flex1" type="text" placeholder="e.g. outfits-femcraft">
                        <div id="outfit_viewer_server_load" class="menu_button">Load</div>
                    </div>
                    <small>Remembered across reloads. Leave empty to use a folder picked from your computer instead:</small>
                    <div class="flex-container">
                        <div id="outfit_viewer_pick" class="menu_button">Choose outfit folder</div>
                        <div id="outfit_viewer_reconnect" class="menu_button">Reconnect folder</div>
                    </div>
                    <small id="outfit_viewer_status"></small>
                    <label for="outfit_viewer_character_folder">Character folder (in data/default-user/user/images/), shown with the 👤 button on the panel, never switched by messages:</label>
                    <div class="flex-container">
                        <input id="outfit_viewer_character_folder" class="text_pole flex1" type="text" placeholder="e.g. characters">
                        <div id="outfit_viewer_character_load" class="menu_button">Load</div>
                    </div>
                    <small id="outfit_viewer_character_status"></small>
                    <input id="outfit_viewer_file_input" type="file" webkitdirectory multiple hidden>
                </div>
            </div>
        </div>
    `);
    $("#extensions_settings2").append(html);

    const save = () => {
        ctx().saveSettingsDebounced();
        applyLayout();
    };
    $("#outfit_viewer_auto")
        .prop("checked", s.autoSwitch)
        .on("change", function () {
            s.autoSwitch = this.checked;
            save();
            renderLock();
        });
    $("#outfit_viewer_only_user")
        .prop("checked", s.onlyUserMessages)
        .on("change", function () {
            s.onlyUserMessages = this.checked;
            save();
        });
    $("#outfit_viewer_desc_toggle")
        .prop("checked", s.showDescription)
        .on("change", function () {
            s.showDescription = this.checked;
            save();
            renderDescription(currentItem());
        });
    $("#outfit_viewer_width_val").text(s.width);
    $("#outfit_viewer_width")
        .val(s.width)
        .on("input", function () {
            s.width = Number(this.value);
            $("#outfit_viewer_width_val").text(s.width);
            save();
        });
    const loadServer = () => {
        s.serverFolder = String(
            $("#outfit_viewer_server_folder").val() ?? "",
        ).trim();
        ctx().saveSettingsDebounced();
        if (s.serverFolder) loadFromServer(s.serverFolder);
    };
    $("#outfit_viewer_server_folder")
        .val(s.serverFolder)
        .on("keydown", (e) => {
            if (e.key === "Enter") loadServer();
        });
    $("#outfit_viewer_server_load").on("click", loadServer);
    const loadCharacters = () => {
        s.characterFolder = String(
            $("#outfit_viewer_character_folder").val() ?? "",
        ).trim();
        ctx().saveSettingsDebounced();
        if (s.characterFolder) loadFromServer(s.characterFolder, "character");
    };
    $("#outfit_viewer_character_folder")
        .val(s.characterFolder)
        .on("keydown", (e) => {
            if (e.key === "Enter") loadCharacters();
        });
    $("#outfit_viewer_character_load").on("click", loadCharacters);
    $("#outfit_viewer_pick").on("click", () => {
        // Picking a local folder takes over from the server folder.
        s.serverFolder = "";
        $("#outfit_viewer_server_folder").val("");
        ctx().saveSettingsDebounced();
        pickFolder();
    });
    $("#outfit_viewer_reconnect").on("click", reconnect);
    $("#outfit_viewer_file_input").on("change", function () {
        const files = Array.from(this.files ?? []);
        const label = files[0]?.webkitRelativePath?.split("/")[0] ?? "folder";
        loadFiles(files, label);
    });
}

function registerCommand() {
    const { SlashCommandParser, SlashCommand, SlashCommandArgument } = ctx();
    if (!SlashCommandParser?.addCommandObject) return;
    SlashCommandParser.addCommandObject(
        SlashCommand.fromProps({
            name: "outfit",
            helpString:
                "Show an outfit in the Outfit Viewer panel. No argument clears it.",
            unnamedArgumentList: [
                SlashCommandArgument.fromProps({
                    description: "outfit name",
                    isRequired: false,
                }),
            ],
            callback: (_args, value) => {
                if (characterMode()) setMode("outfit");
                show(String(value ?? "").trim() || null);
                return views.outfit.current ?? "";
            },
        }),
    );
    SlashCommandParser.addCommandObject(
        SlashCommand.fromProps({
            name: "character",
            helpString:
                "Show a character's picture in the Outfit Viewer panel. No argument goes back to outfits.",
            unnamedArgumentList: [
                SlashCommandArgument.fromProps({
                    description: "character name",
                    isRequired: false,
                }),
            ],
            callback: (_args, value) => {
                const name = String(value ?? "").trim();
                if (!name) {
                    setMode("outfit");
                    return "";
                }
                setMode("character");
                show(name);
                return views.character.current ?? "";
            },
        }),
    );
}

// ---------- startup ----------

jQuery(async () => {
    buildPanel();
    buildSettings();
    applyLayout();
    setMode(settings().mode === "character" ? "character" : "outfit");
    registerCommand();

    const { eventSource, event_types } = ctx();
    let streamTimer = null;
    eventSource.on(event_types.STREAM_TOKEN_RECEIVED, (text) => {
        if (streamTimer) return;
        // Streaming is always the bot's reply.
        if (settings().onlyUserMessages) return;
        streamTimer = setTimeout(() => {
            streamTimer = null;
            scanText(text);
        }, 250);
    });
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, scanMessage);
    eventSource.on(event_types.USER_MESSAGE_RENDERED, scanMessage);
    eventSource.on(event_types.MESSAGE_EDITED, scanMessage);
    eventSource.on(event_types.MESSAGE_SWIPED, scanMessage);
    eventSource.on(event_types.CHAT_CHANGED, restoreForChat);

    await restoreFolder();
});
