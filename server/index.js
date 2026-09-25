// Outfit Viewer server plugin: lists an outfit folder under data/<user>/user/images,
// including one level of subfolders (one subfolder = one outfit with several images).
// Install: copy this folder to SillyTavern/plugins/outfit-viewer and set
// enableServerPlugins: true in config.yaml, then restart SillyTavern.

const fs = require('fs');
const path = require('path');

const IMAGE_EXT = /\.(png|jpe?g|webp|gif|avif)$/i;

function listImages(dir) {
    return fs.readdirSync(dir, { withFileTypes: true })
        .filter(d => IMAGE_EXT.test(d.name) && fs.statSync(path.join(dir, d.name)).isFile())
        .map(d => d.name)
        .sort((a, b) => a.localeCompare(b));
}

async function init(router) {
    // GET /api/plugins/outfit-viewer/list?folder=outfits
    // -> [{ name: "Nurse", files: ["Nurse/a.png", "Nurse/b.png"] }, { name: "Maid", files: ["Maid.png"] }]
    router.get('/list', (req, res) => {
        try {
            const root = req.user?.directories?.userImages;
            const folder = String(req.query.folder ?? '');
            if (!root || !folder) return res.status(400).send({ error: 'No folder specified' });

            const base = path.resolve(root, folder);
            if (!base.startsWith(path.resolve(root) + path.sep)) return res.sendStatus(403);
            if (!fs.existsSync(base)) return res.status(404).send({ error: 'Folder not found' });

            const outfits = [];
            for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
                const full = path.join(base, entry.name);
                // statSync follows links, so linked folders count as folders.
                const stat = fs.statSync(full);
                if (stat.isDirectory()) {
                    const files = listImages(full).map(f => `${entry.name}/${f}`);
                    if (files.length) outfits.push({ name: entry.name, files });
                } else if (stat.isFile() && IMAGE_EXT.test(entry.name)) {
                    outfits.push({ name: entry.name.replace(IMAGE_EXT, ''), files: [entry.name] });
                }
            }
            return res.send(outfits);
        } catch (error) {
            console.error('[outfit-viewer]', error);
            return res.status(500).send({ error: 'Unable to list outfits' });
        }
    });
}

module.exports = {
    init,
    info: {
        id: 'outfit-viewer',
        name: 'Outfit Viewer',
        description: 'Lists outfit images, including subfolders, for the Outfit Viewer extension.',
    },
};
