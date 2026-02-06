
const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { getEmbedding } = require('./rag_api');
const multer = require('multer');
const upload = multer({ dest: 'uploads/' });
const AdmZip = require('adm-zip');

const router = express.Router();

// ... existing helper ...

// POST /api/debug/upload-media
router.post('/upload-media', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const MEDIA_DIR = process.env.MEDIA_DIR || path.join(__dirname, 'media');
    try {
        console.log(`📦 Received ZIP. Extracting to ${MEDIA_DIR}...`);
        const zip = new AdmZip(req.file.path);
        zip.extractAllTo(MEDIA_DIR, true); // overwrite = true

        fs.unlinkSync(req.file.path); // cleanup zip

        const fileCount = fs.readdirSync(MEDIA_DIR).length;
        res.json({ success: true, message: `Extracted to ${MEDIA_DIR}`, count: fileCount });
    } catch (e) {
        console.error('Upload Error:', e);
        res.status(500).json({ error: e.message });
    }
});

// POST /api/debug/sync-gdrive (Emergency Backup)
router.post('/sync-gdrive', (req, res) => {
    console.log('🔄 Triggering Emergency GDrive Sync...');
    // Execute download_media.sh in background
    exec('./download_media.sh', (error, stdout, stderr) => {
        if (error) {
            console.error(`❌ GDrive Sync Error: ${error.message}`);
            return; // Don't crash
        }
        if (stderr) {
            console.error(`⚠️ GDrive Sync Stderr: ${stderr}`);
        }
        console.log(`✅ GDrive Sync Output: ${stdout}`);
    });

    // Respond immediately (don't wait for script)
    res.json({ success: true, message: 'Sync started in background. Check logs.' });
});

const DB_PATH = process.env.DB_PATH || 'ravqa.db';
const MEDIA_DIR = path.join(__dirname, 'media');

// Helper to run embedding batch
async function generateEmbeddingsBatch(limit = 50) {
    const db = new Database(DB_PATH);
    try {
        // Find messages without embeddings
        const rows = db.prepare(`
            SELECT m.id, m.wa_message_id, m.group_name, m.question_text, m.transcript_torah, m.transcript_raw
            FROM messages m
            LEFT JOIN message_embeddings e ON m.id = e.id
            WHERE e.id IS NULL
              AND (m.transcript_torah IS NOT NULL OR m.transcript_raw IS NOT NULL OR m.question_text IS NOT NULL)
            ORDER BY m.ts DESC
            LIMIT ?
        `).all(limit);

        if (rows.length === 0) return { count: 0, message: 'All done' };

        let count = 0;
        for (const r of rows) {
            try {
                // Make Doc Text
                const q = r.question_text || '';
                const a = r.transcript_torah || r.transcript_raw || '';
                const base = `Groupe: ${r.group_name}\nQuestion: ${q}\nRéponse: ${a}`;
                const docText = base.normalize('NFD').replace(/[\u0300-\u036f]/g, '').slice(0, 8000);

                // Generate Embedding
                const vector = await getEmbedding(docText);

                // Insert into message_embeddings
                db.prepare(`
                    INSERT OR REPLACE INTO message_embeddings (id, vector) VALUES (?, ?)
                `).run(r.id, JSON.stringify(vector));

                count++;
            } catch (e) {
                console.error(`Error embedding msg ${r.id}:`, e.message);
            }
        }
        return { count, message: `Processed ${count} messages` };
    } finally {
        db.close();
    }
}

// GET /api/debug/stats
router.get('/stats', (req, res) => {
    const db = new Database(DB_PATH, { readonly: true });
    try {
        const msgCount = db.prepare('SELECT COUNT(*) as c FROM messages').get().c;
        let embCount = 0;
        try {
            embCount = db.prepare('SELECT COUNT(*) as c FROM message_embeddings').get().c;
        } catch (e) { embCount = -1; } // Table might not exist

        // Audio count
        let audioCount = 0;
        if (fs.existsSync(MEDIA_DIR)) {
            audioCount = fs.readdirSync(MEDIA_DIR).filter(f => f.endsWith('.mp3') || f.endsWith('.ogg') || f.endsWith('.opus')).length;
        }

        res.json({
            messages: msgCount,
            embeddings: embCount,
            audio_files: audioCount,
            db_size: fs.statSync(DB_PATH).size,
            uptime: process.uptime()
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    } finally {
        db.close();
    }
});

// POST /api/debug/build-embeddings
router.post('/build-embeddings', async (req, res) => {
    const { limit } = req.body;
    try {
        const result = await generateEmbeddingsBatch(limit || 50);
        res.json(result);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// POST /api/debug/search
router.post('/search', async (req, res) => {
    const { query } = req.body;
    const logs = [];
    const log = (msg) => logs.push(msg);

    try {
        const { searchLocal, getEmbedding } = require('./rag_api');

        log(`Searching for: "${query}"`);
        const vecStart = Date.now();
        const vector = await getEmbedding(query);
        log(`Embedding generated in ${Date.now() - vecStart}ms. Vector length: ${vector.length}`);

        const results = await searchLocal(query, 5);
        log(`searchLocal returned ${results.length} results.`);

        res.json({
            query,
            logs,
            results_count: results.length,
            results: results
        });
    } catch (e) {
        log(`ERROR: ${e.message}`);
        res.status(500).json({ error: e.message, logs });
    }
});

// GET /api/debug/ls
router.get('/ls', (req, res) => {
    const dir = req.query.path || '/app';
    try {
        if (!fs.existsSync(dir)) return res.json({ error: 'Path not found: ' + dir });
        const files = fs.readdirSync(dir).map(f => {
            try {
                const stat = fs.statSync(path.join(dir, f));
                return { name: f, isDir: stat.isDirectory(), size: stat.size };
            } catch (e) { return { name: f, error: e.message }; }
        });
        res.json({ path: dir, files });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// GET /api/debug/cat
router.get('/cat', (req, res) => {
    const filePath = req.query.path;
    try {
        if (!fs.existsSync(filePath)) return res.status(404).send('File not found');
        const content = fs.readFileSync(filePath, 'utf8');
        res.type('text/plain').send(content);
    } catch (e) {
        res.status(500).send(e.message);
    }
});

module.exports = router;
