const MODULE = 'outfitViewer';
const DB_NAME = 'outfit-viewer';
const DB_STORE = 'handles';
const IMAGE_EXT = /\.(png|jpe?g|webp|gif|avif)$/i;

const defaults = {
    enabled: true,
    autoSwitch: true,
    scanUserMessages: true,
    showDescription: true,
    // Folder name under SillyTavern's data/<user>/user/images/. Survives reloads, unlike the browser picker.
    serverFolder: 'outfits',
    width: 320,
    visible: true,
};

const ctx = () => SillyTavern.getContext();

/** @type {{name: string, url: string}[]} */
let outfits = [];
let current = null;
let folderName = '';
let pendingHandle = null;

function settings() {
    const store = ctx().extensionSettings;
    // Fill in missing defaults in place; replacing the object would orphan earlier references.
    store[MODULE] ??= {};
    for (const [key, value] of Object.entries(defaults)) {
        if (store[MODULE][key] === undefined) store[MODULE][key] = value;
    }
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
        const tx = db.transaction(DB_STORE, 'readwrite');
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
        if (type === 'IDAT' || type === 'IEND') break;
        if (type === 'tEXt' || type === 'iTXt') {
            const data = decoder.decode(buf.subarray(pos + 8, pos + 8 + len));
            let prompt = data.slice(data.indexOf('\0') + 1);
            try {
                const json = JSON.parse(prompt);
                prompt = json?.sui_image_params?.prompt ?? json?.prompt ?? prompt;
            } catch {
                prompt = prompt.split('\nNegative prompt:')[0];
            }
            if (typeof prompt === 'string' && prompt.trim()) return prompt;
        }
        pos += 12 + len;
    }
    return null;
}

// The outfit description is everything after the **title**; older prompts have an unbolded
// "Title <weight...>." at the start of the second line instead.
function descriptionFromPrompt(prompt) {
    if (!prompt) return '';
    const bold = prompt.match(/\*\*[^*]+\*\*/);
    if (bold) return prompt.slice(bold.index + bold[0].length).trim();
    const line = prompt.split('\n').slice(1).join('\n');
    const plain = line.match(/^[^\n.]+?(?:<[^>]*>)?\s*\.\s*/);
    return (plain ? line.slice(plain[0].length) : line).trim();
}

async function nameFromPngMetadata(file) {
    if (!/\.png$/i.test(file.name)) return null;
    const prompt = promptFromPng(await file.arrayBuffer());
    const match = prompt?.match(/\n\**\s*([A-Z][A-Za-z]*(?: [a-z]+)?)\s*(?:<|\.|\*)/);
    return match ? match[1] : null;
}

// Description of an outfit, read from its image the first time it's shown, then cached.
async function descriptionOf(outfit) {
    const image = outfit.images[outfit.index];
    if (image.description !== undefined) return image.description;
    try {
        const response = await fetch(image.url);
        image.description = descriptionFromPrompt(promptFromPng(await response.arrayBuffer()));
    } catch (err) {
        console.warn('[Outfit Viewer] could not read description', err);
        image.description = '';
    }
    return image.description;
}

async function outfitName(file) {
    const stem = file.name.replace(IMAGE_EXT, '');
    // Files straight out of an image generator have long auto-generated names.
    if (/masterpiece|^\d{5,}-/i.test(stem)) {
        const fromMeta = await nameFromPngMetadata(file);
        if (fromMeta) return fromMeta;
    }
    return stem;
}

// ---------- loading a folder ----------

function setOutfits(entries, label) {
    outfits.forEach(o => o.images.forEach(i => i.url.startsWith('blob:') && URL.revokeObjectURL(i.url)));
    const byName = new Map();
    for (const entry of entries) {
        const name = entry.name.replace(/\s*\([^()]*\)\s*$/, '').trim() || entry.name;
        const urls = entry.urls;
        let outfit = byName.get(name.toLowerCase());
        if (!outfit) {
            // "Fluffy witch, Paw witch" -> shown as "Fluffy witch", triggered by either key.
            const keys = name.split(',').map(k => k.trim()).filter(Boolean);
            outfit = { name, label: keys[0] ?? name, keys, images: [], index: 0 };
            byName.set(name.toLowerCase(), outfit);
        }
        outfit.images.push(...urls.map(url => ({ url })));
    }
    outfits = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
    folderName = label;
    renderSelect();
    renderStatus();
    restoreForChat();
}

async function loadFiles(files, label) {
    const entries = [];
    for (const file of files) {
        if (!IMAGE_EXT.test(file.name)) continue;
        entries.push({ name: await outfitName(file), urls: [URL.createObjectURL(file)] });
    }
    setOutfits(entries, label);
}

async function loadFromServer(folder) {
    // Cache-bust so an image replaced under the same name shows its new version.
    const stamp = Date.now();
    const urlOf = (file) => `user/images/${encodeURIComponent(folder)}/${file.split('/').map(encodeURIComponent).join('/')}?v=${stamp}`;
    try {
        let entries;
        const plugin = await fetch(`/api/plugins/outfit-viewer/list?folder=${encodeURIComponent(folder)}`, {
            headers: ctx().getRequestHeaders(),
        });
        if (plugin.ok) {
            entries = (await plugin.json()).map(o => ({ name: o.name, urls: o.files.map(urlOf) }));
        } else {
            // No server plugin: flat folder only, one image per outfit.
            const response = await fetch('/api/images/list', {
                method: 'POST',
                headers: ctx().getRequestHeaders(),
                body: JSON.stringify({ folder, sortField: 'name', sortOrder: 'asc', type: 1 }),
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            entries = (await response.json())
                .filter(f => IMAGE_EXT.test(f))
                .map(f => ({ name: f.replace(IMAGE_EXT, ''), urls: [urlOf(f)] }));
        }
        pendingHandle = null;
        setOutfits(entries, `user/images/${folder}`);
    } catch (err) {
        console.error('[Outfit Viewer]', err);
        $('#outfit_viewer_status').text(`Couldn't load user/images/${folder}: ${err.message}`);
    }
}

async function loadFromHandle(handle) {
    const files = [];
    for await (const entry of handle.values()) {
        if (entry.kind === 'file') files.push(await entry.getFile());
    }
    await loadFiles(files, handle.name);
}

async function pickFolder() {
    if (window.showDirectoryPicker) {
        try {
            const handle = await window.showDirectoryPicker({ id: 'outfit-viewer', mode: 'read' });
            await dbSet('folder', handle);
            pendingHandle = null;
            await loadFromHandle(handle);
        } catch (err) {
            if (err.name !== 'AbortError') console.error('[Outfit Viewer]', err);
        }
        return;
    }
    // Firefox fallback: no persistent handle, re-pick each session.
    $('#outfit_viewer_file_input').trigger('click');
}

async function reconnect() {
    if (!pendingHandle) return;
    if (await pendingHandle.requestPermission({ mode: 'read' }) === 'granted') {
        const handle = pendingHandle;
        pendingHandle = null;
        await loadFromHandle(handle);
    }
}

// Re-read the current folder so renamed or newly added images show up.
async function refresh() {
    const icon = $('#outfit_viewer_refresh').addClass('fa-spin');
    try {
        const serverFolder = settings().serverFolder.trim();
        if (serverFolder) return await loadFromServer(serverFolder);
        const handle = window.showDirectoryPicker ? await dbGet('folder') : null;
        if (handle && await handle.requestPermission({ mode: 'read' }) === 'granted') {
            pendingHandle = null;
            return await loadFromHandle(handle);
        }
        // A folder picked through the plain file input can't be re-read; pick it again.
        await pickFolder();
    } finally {
        icon.removeClass('fa-spin');
    }
}

async function restoreFolder() {
    const serverFolder = settings().serverFolder.trim();
    if (serverFolder) return loadFromServer(serverFolder);
    if (!window.showDirectoryPicker) return renderStatus();
    const handle = await dbGet('folder');
    if (!handle) return renderStatus();
    const perm = await handle.queryPermission({ mode: 'read' });
    if (perm === 'granted') return loadFromHandle(handle);
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
    const outfit = outfits.find(o => o.name === current);
    if (!outfit || outfit.images.length < 2) return;
    outfit.index = (outfit.index + delta + outfit.images.length) % outfit.images.length;
    renderImage(outfit);
}

// Click the image for a full-screen view; click anywhere or press Esc to close.
function openLightbox() {
    const src = $('#outfit_viewer_img').attr('src');
    if (!src) return;
    const box = $('<div id="outfit_viewer_lightbox"></div>').append($('<img>').attr('src', src));
    const close = () => { box.remove(); $(document).off('keydown.outfitLightbox'); };
    box.on('click', close);
    $(document).on('keydown.outfitLightbox', (e) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); close(); }
    });
    $('body').append(box);
}

function renderImage(outfit) {
    $('#outfit_viewer_img').attr('src', outfit ? outfit.images[outfit.index].url : '').toggle(!!outfit);
    const many = !!outfit && outfit.images.length > 1;
    $('#outfit_viewer_cycle').toggle(many);
    $('#outfit_viewer_count').toggle(many).text(many ? `${outfit.index + 1}/${outfit.images.length}` : '');
    renderDescription(outfit);
}

function show(name, { persist = true } = {}) {
    const wanted = String(name).toLowerCase();
    const outfit = outfits.find(o => o.name.toLowerCase() === wanted)
        ?? outfits.find(o => o.keys.some(k => k.toLowerCase() === wanted));
    // Arriving at an outfit starts on a random image; staying on it keeps the current one.
    if (outfit && outfit.name !== current) outfit.index = randomIndex(outfit);
    current = outfit ? outfit.name : null;
    $('#outfit_viewer_empty').toggle(!outfit);
    $('#outfit_viewer_select').val(current ?? '');
    renderImage(outfit);
    if (persist) {
        const { chatMetadata, saveMetadataDebounced } = ctx();
        if (chatMetadata) {
            chatMetadata[MODULE] = current;
            saveMetadataDebounced();
        }
    }
}

async function renderDescription(outfit) {
    const box = $('#outfit_viewer_desc');
    if (!outfit || !settings().showDescription) return box.hide().text('');
    const text = await descriptionOf(outfit);
    // A later switch may have happened while this one was loading.
    if (current !== outfit.name) return;
    box.text(text).toggle(!!text).scrollTop(0);
}

function restoreForChat() {
    const saved = ctx().chatMetadata?.[MODULE];
    show(saved ?? null, { persist: false });
}

function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Returns the outfit mentioned last in the text, preferring longer names at the same spot
// ("Fluffy witch" beats "witch").
function findOutfit(text) {
    let best = null;
    for (const o of outfits) {
        for (const key of o.keys) {
            const re = new RegExp(`(?<![\\w])${escapeRegex(key)}(?![\\w])`, 'gi');
            let m;
            while ((m = re.exec(text))) {
                const end = m.index + m[0].length;
                if (!best || end > best.end || (end === best.end && key.length > best.len)) {
                    best = { name: o.name, end, len: key.length };
                }
            }
        }
    }
    return best?.name ?? null;
}

function step(delta) {
    if (!outfits.length) return;
    const index = outfits.findIndex(o => o.name === current);
    const next = index === -1
        ? (delta > 0 ? 0 : outfits.length - 1)
        : (index + delta + outfits.length) % outfits.length;
    show(outfits[next].name);
}

// Status blocks (ID cards, duties, quests) can name outfits that aren't being worn right now.
// Also drops an unclosed block, which is what a message looks like mid-stream.
function stripStatusBlocks(text) {
    return text
        .replace(/<!--\s*GFX_START\s*-->[\s\S]*?<!--\s*GFX_END\s*-->/g, '')
        .replace(/<!--\s*GFX_START\s*-->[\s\S]*$/, '');
}

function scanText(text) {
    const s = settings();
    if (!s.enabled || !s.autoSwitch || !text || !outfits.length) return;
    const found = findOutfit(stripStatusBlocks(text));
    if (found && found !== current) show(found);
}

function scanMessage(id) {
    const msg = ctx().chat?.[id];
    if (!msg) return;
    if (msg.is_user && !settings().scanUserMessages) return;
    scanText(msg.mes);
}

// ---------- UI ----------

function renderSelect() {
    const select = $('#outfit_viewer_select').empty();
    select.append($('<option>').val('').text(outfits.length ? '— none —' : '— no folder —'));
    // Show every key, so it's clear which words bring each outfit up.
    for (const o of outfits) {
        const count = o.images.length > 1 ? ` (${o.images.length})` : '';
        select.append($('<option>').val(o.name).text(o.keys.join(', ') + count));
    }
    select.val(current ?? '');
}

function renderStatus() {
    const status = $('#outfit_viewer_status');
    const reconnectBtn = $('#outfit_viewer_reconnect');
    if (pendingHandle) {
        status.text(`Folder "${pendingHandle.name}" needs permission again.`);
        reconnectBtn.show();
    } else if (folderName) {
        status.text(`Folder "${folderName}": ${outfits.length} outfit(s).`);
        reconnectBtn.hide();
    } else {
        status.text('No folder selected.');
        reconnectBtn.hide();
    }
}

function applyLayout() {
    const s = settings();
    const panel = $('#outfit_viewer_panel')
        .css('width', `${s.width}px`)
        .toggle(s.enabled && s.visible);
    $('#outfit_viewer_toggle').toggle(s.enabled && !s.visible);
    if (s.position) {
        panel.css({ left: `${s.position.left}px`, top: `${s.position.top}px`, right: 'auto' });
        clampToViewport();
    } else {
        panel.css({ left: '', top: '', right: '' });
    }
}

function clampToViewport() {
    const panel = document.getElementById('outfit_viewer_panel');
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
    const panel = document.getElementById('outfit_viewer_panel');
    const header = panel.querySelector('.outfit_viewer_header');
    header.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 || e.target.closest('select, .outfit_viewer_icon')) return;
        e.preventDefault();
        const rect = panel.getBoundingClientRect();
        const offsetX = e.clientX - rect.left;
        const offsetY = e.clientY - rect.top;
        header.setPointerCapture(e.pointerId);
        panel.classList.add('dragging');
        const move = (ev) => {
            settings().position = { left: ev.clientX - offsetX, top: ev.clientY - offsetY };
            panel.style.right = 'auto';
            clampToViewport();
        };
        const up = () => {
            header.removeEventListener('pointermove', move);
            header.removeEventListener('pointerup', up);
            panel.classList.remove('dragging');
            ctx().saveSettingsDebounced();
        };
        header.addEventListener('pointermove', move);
        header.addEventListener('pointerup', up);
    });
    // Double-click the header to snap back to the default spot.
    header.addEventListener('dblclick', (e) => {
        if (e.target.closest('select, .outfit_viewer_icon')) return;
        delete settings().position;
        ctx().saveSettingsDebounced();
        applyLayout();
    });
    window.addEventListener('resize', clampToViewport);
}

// Scroll or arrow keys while the pointer is over the panel flip through outfits.
function enableBrowsing() {
    const panel = document.getElementById('outfit_viewer_panel');
    let hovering = false;
    let lastWheel = 0;
    panel.addEventListener('pointerenter', () => { hovering = true; });
    panel.addEventListener('pointerleave', () => { hovering = false; });
    panel.addEventListener('wheel', (e) => {
        // Let the dropdown and the description box scroll normally.
        if (e.target.closest('select, #outfit_viewer_desc')) return;
        e.preventDefault();
        const now = Date.now();
        if (now - lastWheel < 150) return;
        lastWheel = now;
        step(e.deltaY > 0 ? 1 : -1);
    }, { passive: false });
    document.addEventListener('keydown', (e) => {
        if (!hovering || !$(panel).is(':visible')) return;
        if (e.target.closest('input, textarea, [contenteditable="true"]')) return;
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
        // Capture phase, so SillyTavern's own arrow-key swiping doesn't also fire.
        e.preventDefault();
        e.stopImmediatePropagation();
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') cycleImage(e.key === 'ArrowDown' ? 1 : -1);
        else step(e.key === 'ArrowRight' ? 1 : -1);
    }, true);
}

function buildPanel() {
    const panel = $(`
        <div id="outfit_viewer_panel">
            <div class="outfit_viewer_header">
                <div class="outfit_viewer_grip fa-solid fa-grip-vertical" title="Drag to move · double-click to reset"></div>
                <select id="outfit_viewer_select" title="Pick an outfit"></select>
                <small id="outfit_viewer_count"></small>
                <div id="outfit_viewer_cycle" class="outfit_viewer_icon fa-solid fa-up-down" title="Next image of this outfit (↑/↓)"></div>
                <div id="outfit_viewer_refresh" class="outfit_viewer_icon fa-solid fa-rotate" title="Reload folder"></div>
                <div id="outfit_viewer_hide" class="outfit_viewer_icon fa-solid fa-xmark" title="Hide"></div>
            </div>
            <img id="outfit_viewer_img" alt="" />
            <div id="outfit_viewer_empty">No outfit</div>
            <div id="outfit_viewer_desc"></div>
        </div>
        <div id="outfit_viewer_toggle" class="fa-solid fa-shirt" title="Show outfit"></div>
    `);
    $('body').append(panel);
    $('#outfit_viewer_select').on('change', function () { show(this.value || null); });
    $('#outfit_viewer_refresh').on('click', refresh);
    $('#outfit_viewer_cycle').on('click', () => cycleImage(1)).hide();
    $('#outfit_viewer_img').on('click', openLightbox);
    $('#outfit_viewer_count').hide();
    $('#outfit_viewer_hide').on('click', () => { settings().visible = false; ctx().saveSettingsDebounced(); applyLayout(); });
    $('#outfit_viewer_toggle').on('click', () => { settings().visible = true; ctx().saveSettingsDebounced(); applyLayout(); });
    $('#outfit_viewer_empty').show();
    $('#outfit_viewer_img').hide().attr('draggable', 'false');
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
                    <label class="checkbox_label"><input id="outfit_viewer_enabled" type="checkbox"> Enabled</label>
                    <label class="checkbox_label"><input id="outfit_viewer_auto" type="checkbox"> Switch automatically when an outfit is mentioned</label>
                    <label class="checkbox_label"><input id="outfit_viewer_user" type="checkbox"> Also scan my own messages</label>
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
                    <input id="outfit_viewer_file_input" type="file" webkitdirectory multiple hidden>
                </div>
            </div>
        </div>
    `);
    $('#extensions_settings2').append(html);

    const save = () => { ctx().saveSettingsDebounced(); applyLayout(); };
    $('#outfit_viewer_enabled').prop('checked', s.enabled).on('change', function () { s.enabled = this.checked; save(); });
    $('#outfit_viewer_auto').prop('checked', s.autoSwitch).on('change', function () { s.autoSwitch = this.checked; save(); });
    $('#outfit_viewer_user').prop('checked', s.scanUserMessages).on('change', function () { s.scanUserMessages = this.checked; save(); });
    $('#outfit_viewer_desc_toggle').prop('checked', s.showDescription).on('change', function () {
        s.showDescription = this.checked;
        save();
        renderDescription(outfits.find(o => o.name === current));
    });
    $('#outfit_viewer_width_val').text(s.width);
    $('#outfit_viewer_width').val(s.width).on('input', function () {
        s.width = Number(this.value);
        $('#outfit_viewer_width_val').text(s.width);
        save();
    });
    const loadServer = () => {
        s.serverFolder = String($('#outfit_viewer_server_folder').val() ?? '').trim();
        ctx().saveSettingsDebounced();
        if (s.serverFolder) loadFromServer(s.serverFolder);
    };
    $('#outfit_viewer_server_folder').val(s.serverFolder).on('keydown', (e) => { if (e.key === 'Enter') loadServer(); });
    $('#outfit_viewer_server_load').on('click', loadServer);
    $('#outfit_viewer_pick').on('click', () => {
        // Picking a local folder takes over from the server folder.
        s.serverFolder = '';
        $('#outfit_viewer_server_folder').val('');
        ctx().saveSettingsDebounced();
        pickFolder();
    });
    $('#outfit_viewer_reconnect').on('click', reconnect);
    $('#outfit_viewer_file_input').on('change', function () {
        const files = Array.from(this.files ?? []);
        const label = files[0]?.webkitRelativePath?.split('/')[0] ?? 'folder';
        loadFiles(files, label);
    });
}

function registerCommand() {
    const { SlashCommandParser, SlashCommand, SlashCommandArgument } = ctx();
    if (!SlashCommandParser?.addCommandObject) return;
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'outfit',
        helpString: 'Show an outfit in the Outfit Viewer panel. No argument clears it.',
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({ description: 'outfit name', isRequired: false }),
        ],
        callback: (_args, value) => {
            show(String(value ?? '').trim() || null);
            return current ?? '';
        },
    }));
}

// ---------- startup ----------

jQuery(async () => {
    buildPanel();
    buildSettings();
    applyLayout();
    renderSelect();
    registerCommand();

    const { eventSource, event_types } = ctx();
    let streamTimer = null;
    eventSource.on(event_types.STREAM_TOKEN_RECEIVED, (text) => {
        if (streamTimer) return;
        streamTimer = setTimeout(() => { streamTimer = null; scanText(text); }, 250);
    });
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, scanMessage);
    eventSource.on(event_types.USER_MESSAGE_RENDERED, scanMessage);
    eventSource.on(event_types.MESSAGE_EDITED, scanMessage);
    eventSource.on(event_types.MESSAGE_SWIPED, scanMessage);
    eventSource.on(event_types.CHAT_CHANGED, restoreForChat);

    await restoreFolder();
});
