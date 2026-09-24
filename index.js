const MODULE = 'outfitViewer';
const DB_NAME = 'outfit-viewer';
const DB_STORE = 'handles';
const IMAGE_EXT = /\.(png|jpe?g|webp|gif|avif)$/i;

const defaults = {
    enabled: true,
    autoSwitch: true,
    scanUserMessages: true,
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
async function nameFromPngMetadata(file) {
    if (!/\.png$/i.test(file.name)) return null;
    const buf = new Uint8Array(await file.arrayBuffer());
    const view = new DataView(buf.buffer);
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
            } catch { /* A1111-style plain text */ }
            const match = String(prompt).match(/\n\**\s*([A-Z][A-Za-z]*(?: [a-z]+)?)\s*(?:<|\.|\*)/);
            if (match) return match[1];
        }
        pos += 12 + len;
    }
    return null;
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
    outfits.forEach(o => o.url.startsWith('blob:') && URL.revokeObjectURL(o.url));
    const loaded = [];
    const seen = new Map();
    for (let { name, url } of entries) {
        const count = (seen.get(name) ?? 0) + 1;
        seen.set(name, count);
        if (count > 1) name = `${name} ${count}`;
        // "Fluffy witch, Paw witch.png" -> shown as "Fluffy witch", triggered by either key.
        const keys = name.split(',').map(k => k.trim()).filter(Boolean);
        loaded.push({ name, label: keys[0] ?? name, keys, url });
    }
    loaded.sort((a, b) => a.name.localeCompare(b.name));
    outfits = loaded;
    folderName = label;
    renderSelect();
    renderStatus();
    restoreForChat();
}

async function loadFiles(files, label) {
    const entries = [];
    for (const file of files) {
        if (!IMAGE_EXT.test(file.name)) continue;
        entries.push({ name: await outfitName(file), url: URL.createObjectURL(file) });
    }
    setOutfits(entries, label);
}

async function loadFromServer(folder) {
    try {
        const response = await fetch('/api/images/list', {
            method: 'POST',
            headers: ctx().getRequestHeaders(),
            body: JSON.stringify({ folder, sortField: 'name', sortOrder: 'asc', type: 1 }),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const files = await response.json();
        const entries = files
            .filter(f => IMAGE_EXT.test(f))
            .map(f => ({
                name: f.replace(IMAGE_EXT, ''),
                url: `user/images/${encodeURIComponent(folder)}/${encodeURIComponent(f)}`,
            }));
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

function show(name, { persist = true } = {}) {
    const wanted = String(name).toLowerCase();
    const outfit = outfits.find(o => o.name.toLowerCase() === wanted)
        ?? outfits.find(o => o.keys.some(k => k.toLowerCase() === wanted));
    current = outfit ? outfit.name : null;
    $('#outfit_viewer_img').attr('src', outfit ? outfit.url : '').toggle(!!outfit);
    $('#outfit_viewer_empty').toggle(!outfit);
    $('#outfit_viewer_select').val(current ?? '');
    if (persist) {
        const { chatMetadata, saveMetadataDebounced } = ctx();
        if (chatMetadata) {
            chatMetadata[MODULE] = current;
            saveMetadataDebounced();
        }
    }
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

function scanText(text) {
    const s = settings();
    if (!s.enabled || !s.autoSwitch || !text || !outfits.length) return;
    const found = findOutfit(text);
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
    for (const o of outfits) select.append($('<option>').val(o.name).text(o.keys.join(', ')));
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
        if (e.button !== 0 || e.target.closest('select, #outfit_viewer_hide')) return;
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
        if (e.target.closest('select, #outfit_viewer_hide')) return;
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
        if (e.target.closest('select')) return;
        e.preventDefault();
        const now = Date.now();
        if (now - lastWheel < 150) return;
        lastWheel = now;
        step(e.deltaY > 0 ? 1 : -1);
    }, { passive: false });
    document.addEventListener('keydown', (e) => {
        if (!hovering || !$(panel).is(':visible')) return;
        if (e.target.closest('input, textarea, [contenteditable="true"]')) return;
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        // Capture phase, so SillyTavern's own arrow-key swiping doesn't also fire.
        e.preventDefault();
        e.stopImmediatePropagation();
        step(e.key === 'ArrowRight' ? 1 : -1);
    }, true);
}

function buildPanel() {
    const panel = $(`
        <div id="outfit_viewer_panel">
            <div class="outfit_viewer_header">
                <div class="outfit_viewer_grip fa-solid fa-grip-vertical" title="Drag to move · double-click to reset"></div>
                <select id="outfit_viewer_select" title="Pick an outfit"></select>
                <div id="outfit_viewer_hide" class="fa-solid fa-xmark" title="Hide"></div>
            </div>
            <img id="outfit_viewer_img" alt="" />
            <div id="outfit_viewer_empty">No outfit</div>
        </div>
        <div id="outfit_viewer_toggle" class="fa-solid fa-shirt" title="Show outfit"></div>
    `);
    $('body').append(panel);
    $('#outfit_viewer_select').on('change', function () { show(this.value || null); });
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
