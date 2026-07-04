// FIX LOCAL SSL ISSUES
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

/**
 * RavQA Server - Version 2.0 Refonte
 * Architecture épurée et moderne
 */

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const AdmZip = require('adm-zip'); // For DB auto-restore

// --- AUTO-RESTORE DB ---
const DB_PATH = process.env.DB_PATH || './ravqa.db';
const ZIP_PATH = './ravqa.db.zip';

if (fs.existsSync(ZIP_PATH)) {
    console.log('📦 Found ravqa.db.zip, checking if restore needed...');
    const zipStats = fs.statSync(ZIP_PATH);

    let needRestore = false;
    if (!fs.existsSync(DB_PATH)) {
        console.log('✨ DB missing. Restoring from zip...');
        needRestore = true;
    } else {
        const dbStats = fs.statSync(DB_PATH);
        // If zip is newer than DB (deployment update), restore
        // Note: In persistent volume, DB might be newer than deployment zip. 
        // Strategy: Only restore if DB is significantly smaller or missing? 
        // Safer strategy for "Zero Config" Deployment: 
        // If we just deployed a NEW zip, we probably want it. 
        // BUT if user used the app, DB grew. 
        // Let's assume for this "Fix", we want the zip content.
        // To be safe: Restore if DB is missing.
        // For updates: We might need a flag or manual action.
        // Current User Request: Sync Local -> Railway. So we want to overwrite.
        if (zipStats.mtime > dbStats.mtime) {
            console.log('🔄 Zip is newer than DB. Restoring update...');
            // needRestore = true; // CAREFUL: Docker mtime might be tricky.
            // For now, let's stick to "Restore if missing" to be safe against data loss,
            // UNLESS user explicitly wants to overwrite.
            // User wants to SYNC. So force restore this time?
            // Let's do: If DB < 1MB (empty) or missing.
        }
    }

    if (needRestore || process.env.FORCE_RESTORE_DB === 'true') {
        try {
            const zip = new AdmZip(ZIP_PATH);
            zip.extractAllTo('./', true);
            console.log('✅ DB Restored from zip successfully.');
        } catch (e) {
            console.error('❌ DB Restore failed:', e);
        }
    } else {
        console.log('⏩ Skipping DB restore (DB exists).');
    }
}
// -----------------------

require('dotenv').config();
const Database = require('better-sqlite3');

// Import WhatsApp ZIP processor
const { importWhatsAppZip } = require('./import_chat_zip');

// Import RAG Search API
// Import invalidateCache
const { setupRAGEndpoints, invalidateCache, searchLocal } = require('./rag_api');

// ...


// Import AI Assistant
const { setupAIAssistantEndpoints } = require('./ai_assistant');

// Configuration
// const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'ravqa.db'); // DB_PATH is now defined above
const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = path.join(__dirname, 'uploads');

// Créer dossier uploads si nécessaire
if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// Configuration multer pour gros fichiers
const storage = multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => {
        const uniqueName = `whatsapp_${Date.now()}_${file.originalname}`;
        cb(null, uniqueName);
    }
});

const upload = multer({
    storage,
    limits: { fileSize: 2500 * 1024 * 1024 }, // 2.5GB max
    fileFilter: (req, file, cb) => {
        if (file.mimetype === 'application/zip' || file.originalname.endsWith('.zip')) {
            cb(null, true);
        } else {
            cb(new Error('Seuls les fichiers ZIP sont acceptés'));
        }
    }
});

// Initialisation
const { setupV2StreamingRoutes } = require('./server_routes_v2');
const { setupAIRouterEndpoints } = require('./ai_router');
const maintenanceRoutes = require('./maintenance_routes');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Lancement du Bot (Uniquement si activé)
if (process.env.ENABLE_BOT === 'true') {
    const { initBot } = require('./bot');
    initBot().catch(err => console.error('❌ Bot Init Error:', err));
} else {
    console.log('ℹ️ Bot désactivé (ENABLE_BOT != true) - Mode API/Web uniquement');
}

app.use(express.static(path.join(__dirname, 'public'), {
    setHeaders: (res, path) => {
        if (path.endsWith('.html')) {
            // Force browser to always check for the newest version of index.html
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
        }
    }
}));
const MEDIA_DIR = process.env.MEDIA_DIR ? path.resolve(process.env.MEDIA_DIR) : path.join(__dirname, 'media');
// Audio Middleware: Fallback .ogg -> .mp3 AND RAV_ABICHID_DB Lookup
const { spawn } = require('child_process');
const FFMPEG_BIN = '/usr/local/bin/ffmpeg';

/**
 * Stream any audio file (OGG, Opus, etc.) transcoded to MP3 on-the-fly.
 * Uses the system ffmpeg binary — no npm package required.
 */
function streamAsMp3(res, sourcePath) {
    console.log(`🎵 [FFMPEG] Transcoding to MP3: ${path.basename(sourcePath)}`);
    res.setHeader('Content-Type', 'audio/mpeg');
    // No Content-Length as we are streaming live — seeking is limited but playback works.

    const args = [
        '-i', sourcePath,
        '-f', 'mp3',
        '-acodec', 'libmp3lame',
        '-q:a', '4',   // Good-quality VBR
        'pipe:1'       // Output to stdout
    ];

    const proc = spawn(FFMPEG_BIN, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    proc.stdout.pipe(res);

    proc.on('error', (err) => {
        console.error(`❌ [FFMPEG] Error: ${err.message}`);
        if (!res.headersSent) res.status(500).send('Transcoding error');
    });

    res.on('close', () => {
        // Client disconnected — cleanly kill ffmpeg
        if (!proc.killed) proc.kill();
    });
}

const ravDb = require('./rav_db_integration');
// Load index asynchronously on start
setTimeout(() => ravDb.loadIndex(), 1000);

app.use('/audio', (req, res, next) => {
    // 0. SAFARI FIX: Safari refuses to load .ogg in <audio> tags. Redirect strictly to .mp3 so the browser tries the MP3 payload
    if (req.path.match(/\.(ogg|opus)$/i)) {
        const mp3Path = req.originalUrl.replace(/\.(ogg|opus)$/i, '.mp3');
        // console.log(`🔄 Redirecting ${req.originalUrl} to ${mp3Path} for Safari compatibility.`);
        return res.redirect(301, mp3Path);
    }

    // 1. If request is for .mp3, check local and RAV_DB, then fallback to .ogg/.opus
    if (req.path.endsWith('.mp3')) {
        const originalPath = path.join(MEDIA_DIR, req.path);
        if (fs.existsSync(originalPath)) return next();

        const filename = path.basename(req.path);

        // Check local .ogg first — transcode to real MP3 for Safari compatibility
        const localOggPath = path.join(MEDIA_DIR, filename.replace(/\.mp3$/, '.ogg'));
        if (fs.existsSync(localOggPath)) {
            return streamAsMp3(res, localOggPath);
        }

        // Check local .opus — transcode to real MP3 for Safari compatibility
        const localOpusPath = path.join(MEDIA_DIR, filename.replace(/\.mp3$/, '.opus'));
        if (fs.existsSync(localOpusPath)) {
            return streamAsMp3(res, localOpusPath);
        }

        const externalPath = ravDb.findFilePath(filename);
        if (externalPath && fs.existsSync(externalPath)) {
            console.log(`🔍 Serving native MP3 from RAV_DB: ${filename}`);
            return res.sendFile(externalPath);
        }

        const oggFilename = filename.replace(/\.mp3$/, '.ogg');
        const oggPath = ravDb.findFilePath(oggFilename);
        if (oggPath && fs.existsSync(oggPath)) {
            return streamAsMp3(res, oggPath);
        }

        const opusFilename = filename.replace(/\.mp3$/, '.opus');
        const opusPath = ravDb.findFilePath(opusFilename);
        if (opusPath && fs.existsSync(opusPath)) {
            return streamAsMp3(res, opusPath);
        }
    }

    // 2. If request is for .ogg or .opus, check if we have .mp3 instead (Should be caught by redirect, but safety net)
    if (req.path.match(/\.(ogg|opus)$/i)) {
        const originalPath = path.join(MEDIA_DIR, req.path);

        if (fs.existsSync(originalPath)) return next();

        const mp3Path = originalPath.replace(/\.(ogg|opus)$/i, '.mp3');
        if (fs.existsSync(mp3Path)) return res.sendFile(mp3Path);

        const filename = path.basename(req.path);
        const externalPath = ravDb.findFilePath(filename);
        if (externalPath && fs.existsSync(externalPath)) {
            console.log(`🔍 Serving from RAV_DB: ${filename}`);
            return res.sendFile(externalPath);
        }

        const mp3Filename = filename.replace(/\.(ogg|opus)$/i, '.mp3');
        const externalMp3Path = ravDb.findFilePath(mp3Filename);
        if (externalMp3Path && fs.existsSync(externalMp3Path)) {
            console.log(`🔍 Serving MP3 from RAV_DB: ${mp3Filename}`);
            return res.sendFile(externalMp3Path);
        }
    }

    // If not special case, or not found yet, let static try (it will 404 if not found)
    // But wait, express.static handles normal files.
    // If we want to catch ALL missing audio, we should do this fallback logic for ANY audio request.

    // Let's broaden the scope: if expected file is missing locally, check RAV_DB.
    const requestedPath = path.join(MEDIA_DIR, req.path);
    if (!fs.existsSync(requestedPath)) {
        const filename = path.basename(req.path);
        const externalPath = ravDb.findFilePath(filename);
        if (externalPath && fs.existsSync(externalPath)) {
            console.log(`🔍 Serving from RAV_DB: ${filename}`);
            return res.sendFile(externalPath);
        }
    }

    // CRITICAL: Do NOT call next() for /audio routes if the file is truly completely missing.
    // Otherwise, the React catch-all `app.get('*')` will serve index.html as an audio file, breaking the browser player.
    return res.status(404).send('Audio file not found in local media or RAV_DB');
});

app.use('/audio', express.static(MEDIA_DIR));
console.log(`📂 Audio Directory: ${MEDIA_DIR}`);

// =============================================================================
// BACKBLAZE B2 AUDIO PROXY (Cloud/Railway Mode)
// When B2_KEY_ID and B2_APP_KEY are set, proxy /audio-b2/:filename from B2 private bucket.
// =============================================================================
if (process.env.B2_KEY_ID && process.env.B2_APP_KEY && process.env.B2_BUCKET_NAME) {
    const https = require('https');

    let b2AuthToken = null;
    let b2ApiUrl = null;
    let b2DownloadUrl = null;

    async function authorizeB2() {
        return new Promise((resolve, reject) => {
            const credentials = Buffer.from(`${process.env.B2_KEY_ID}:${process.env.B2_APP_KEY}`).toString('base64');
            const options = {
                hostname: 'api.backblazeb2.com',
                path: '/b2api/v3/b2_authorize_account',
                headers: { Authorization: `Basic ${credentials}` }
            };
            https.get(options, (resp) => {
                let data = '';
                resp.on('data', (d) => data += d);
                resp.on('end', () => {
                    try {
                        const json = JSON.parse(data);
                        b2AuthToken = json.authorizationToken;
                        b2ApiUrl = json.apiInfo?.storageApi?.apiUrl || json.apiUrl;
                        b2DownloadUrl = json.apiInfo?.storageApi?.downloadUrl || json.downloadUrl;
                        console.log(`✅ [B2] Authorized. Download URL: ${b2DownloadUrl}`);
                        resolve();
                    } catch (e) { reject(e); }
                });
            }).on('error', reject);
        });
    }

    // Authorize on startup
    authorizeB2().catch(e => console.error('❌ [B2] Auth failed:', e.message));

    app.get('/audio-b2/:filename', async (req, res) => {
        if (!b2AuthToken) {
            try { await authorizeB2(); } catch (e) {
                return res.status(503).send('B2 auth unavailable');
            }
        }

        const bucketName = process.env.B2_BUCKET_NAME;

        function tryFetch(ext, isFallback = false) {
            const currentFilename = req.params.filename.replace(/\.(mp3|ogg|opus)$/i, ext);
            const url = `${b2DownloadUrl}/file/${bucketName}/${currentFilename}`;

            https.get(url, { headers: { Authorization: b2AuthToken } }, (b2Res) => {
                if (b2Res.statusCode === 401) {
                    if (!isFallback) {
                        // Re-auth once
                        authorizeB2().then(() => tryFetch(ext, isFallback)).catch(() => res.status(503).send('B2 re-auth failed'));
                        return;
                    }
                    return res.status(401).send('B2 Unauthorized');
                }

                if (b2Res.statusCode === 404) {
                    if (ext === '.mp3') return tryFetch('.ogg', true);
                    if (ext === '.ogg') return tryFetch('.opus', true);
                    return res.status(404).send('Audio not found in B2');
                }

                if (b2Res.statusCode === 200) {
                    if (isFallback) {
                        // Transcode .ogg or .opus Stream -> MP3
                        const { spawn } = require('child_process');
                        const ffmpeg = spawn('ffmpeg', [
                            '-i', 'pipe:0',
                            '-f', 'mp3',
                            '-acodec', 'libmp3lame',
                            '-q:a', '4',
                            'pipe:1'
                        ], { stdio: ['pipe', 'pipe', 'ignore'] });

                        res.setHeader('Content-Type', 'audio/mpeg');
                        b2Res.pipe(ffmpeg.stdin);
                        ffmpeg.stdout.pipe(res);

                        ffmpeg.on('error', (e) => {
                            console.error('B2 FFMPEG error:', e);
                            if (!res.headersSent) res.status(500).send('Transcoding error');
                        });
                        res.on('close', () => { if (!ffmpeg.killed) ffmpeg.kill(); });
                    } else {
                        // Direct stream for native .mp3
                        res.setHeader('Content-Type', 'audio/mpeg');
                        if (b2Res.headers['content-length']) {
                            res.setHeader('Content-Length', b2Res.headers['content-length']);
                        }
                        b2Res.pipe(res);
                    }
                } else {
                    res.status(b2Res.statusCode).send('B2 Fetch Error');
                }
            }).on('error', e => res.status(500).send('Network error to B2'));
        }

        tryFetch('.mp3');
    });
    console.log('🪣 [B2] Audio proxy enabled at /audio-b2/:filename with FFMPEG fallback');
}


// Mount Maintenance/Debug Routes (CRITICAL for diagnostics)
app.use('/api/debug', maintenanceRoutes);

// =============================================================================
// DATABASE HELPER
// =============================================================================

function getDB() {
    return new Database(DB_PATH);
}

// Initialize Database Schema
function initializeSchema() {
    const db = getDB();
    try {
        db.exec(`
            CREATE TABLE IF NOT EXISTS suggestions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                message_id INTEGER,
                type TEXT, -- 'edit', 'delete', 'relink'
                payload TEXT, -- JSON content
                status TEXT DEFAULT 'pending', -- 'pending', 'approved', 'rejected'
                created_at INTEGER,
                suggester_ip TEXT
            );
            CREATE TABLE IF NOT EXISTS visitor_stats (
                date TEXT PRIMARY KEY,
                count INTEGER DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS visitor_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ts INTEGER,
                ip TEXT,
                user_agent TEXT
            )
        `);
        console.log('✅ DB Schema initialized (suggestions table check)');
    } catch (e) {
        console.error('❌ DB Schema init failed:', e);
    } finally {
        db.close();
    }
}
initializeSchema();

// Setup V2 Routes (Streaming & AI Router)
setupV2StreamingRoutes(app);
setupAIRouterEndpoints(app);
app.use('/api/debug', maintenanceRoutes);

// Helper: Get audio URL preferring MP3 over OGG for iOS compatibility
function getAudioUrl(audioPath) {
    if (!audioPath) return null;

    const basename = path.basename(audioPath);
    // Use the same MEDIA_DIR defined earlier (need to move definition up or reuse)
    const mediaDir = process.env.MEDIA_DIR ? path.resolve(process.env.MEDIA_DIR) : path.join(__dirname, 'media');

    // 1. Check exact match (or OGG)
    if (fs.existsSync(path.join(mediaDir, basename))) {
        return `/audio/${basename}`;
    }

    // 2. Check MP3 version of the exact name
    const mp3Name = basename.replace(/\.(ogg|opus)$/i, '.mp3');
    if (fs.existsSync(path.join(mediaDir, mp3Name))) {
        return `/audio/${mp3Name}`;
    }

    // 3. Loose match: Try to find by unique suffix (often the ID part)
    // DB Format: false_972546314770-1488386952@g.us_3A03A0FDE1CAF2E28388_192491911393282@lid.ogg
    // Target: 3A03A0FDE1CAF2E28388.mp3 or similar

    // Extract the "ID" part. Usually between the last underscore and the extension, OR a long hex string.
    // Attempt A: Extract last segment after underscore (excluding @lid stuff if present)
    // Actually, many recovered files are just "ID.mp3" or "YYYY-MM-DD-AUDIO-....mp3".

    // Let's look for files that *contain* parts of the basename.
    // This is expensive if we do readdir every time, but for now it's necessary.
    // Optimization: We could cache the file list.

    // Simple heuristic: If the file has a long hex string, look for that.
    const hexMatch = basename.match(/[A-F0-9]{18,}/);
    if (hexMatch) {
        const idPart = hexMatch[0];
        const potentialMatch = idPart + '.mp3';
        if (fs.existsSync(path.join(mediaDir, potentialMatch))) {
            return `/audio/${potentialMatch}`;
        }
    }

    return `/audio/${basename}`; // Return original as fallback (client might get 404 but we tried)
}

// =============================================================================
// ADMIN AUTH SYSTEM (Simple Password)
// =============================================================================

const crypto = require('crypto');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Rav2026!'; // Default fallback
const ADMIN_TOKENS = new Set();  // token (in-memory session)

// Middleware: Require Admin
const requireAdmin = (req, res, next) => {
    const token = req.headers['x-admin-token'];
    if (!token || !ADMIN_TOKENS.has(token)) {
        return res.status(403).json({ error: 'Accès refusé. Token invalide.' });
    }
    next();
};

// Login: Password Check
app.post('/api/auth/login', (req, res) => {
    const { password } = req.body;

    // Check Password
    if (!password || password !== ADMIN_PASSWORD) {
        // Slow down brute force (basic delay)
        return setTimeout(() => res.status(403).json({ error: 'Mot de passe incorrect.' }), 1000);
    }

    // Generate Session Token
    const token = crypto.randomBytes(32).toString('hex');
    ADMIN_TOKENS.add(token);

    res.json({ success: true, token });
});

app.post('/api/auth/check', requireAdmin, (req, res) => {
    res.json({ success: true });
});

app.post('/api/auth/check', requireAdmin, (req, res) => {
    res.json({ success: true });
});

// =============================================================================
// API ENDPOINTS - Core
// =============================================================================

// Health check
app.get('/api/health', (req, res) => {
    const db = getDB();
    const stats = db.prepare('SELECT COUNT(*) as total FROM messages WHERE deleted_at IS NULL').get();
    db.close();

    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        messages: stats.total,
        uptime: process.uptime()
    });
});

// Debug endpoint to check media files
app.get('/api/debug/media', (req, res) => {
    const mediaDir = path.join(__dirname, 'media');
    try {
        if (!fs.existsSync(mediaDir)) {
            return res.json({ error: 'Media directory not found', path: mediaDir });
        }
        const files = fs.readdirSync(mediaDir);
        const mp3Count = files.filter(f => f.endsWith('.mp3')).length;
        const oggCount = files.filter(f => f.endsWith('.ogg')).length;
        const sampleFiles = files.slice(0, 10).map(f => ({
            name: f,
            size: fs.statSync(path.join(mediaDir, f)).size
        }));

        res.json({
            totalFiles: files.length,
            mp3Count,
            oggCount,
            mediaPath: mediaDir,
            samples: sampleFiles
        });
    } catch (error) {
        res.status(500).json({ error: error.message, stack: error.stack });
    }
});

// Stats globales
app.get('/api/stats', (req, res) => {
    const db = getDB();
    const stats = db.prepare(`
        SELECT 
            COUNT(*) as total,
            SUM(CASE WHEN length(transcript_torah) > 50 THEN 1 ELSE 0 END) as with_answer,
            SUM(CASE WHEN audio_path IS NOT NULL THEN 1 ELSE 0 END) as with_audio
        FROM messages WHERE deleted_at IS NULL
    `).get();
    db.close();

    res.json(stats);
});

// =============================================================================
// API ENDPOINTS - Search
// =============================================================================

// Recherche principale
app.get('/api/search', async (req, res) => {
    const { q, limit = 20, page = 1 } = req.query;

    if (!q || q.length < 2) {
        return res.json({ results: [], total: 0 });
    }

    const db = getDB();
    const offset = (page - 1) * limit;

    // Recherche FTS5
    const searchTerms = q.split(' ').filter(t => t.length > 1).join(' AND ');

    let results = [];
    try {
        results = db.prepare(`
            SELECT m.id, m.question_text, m.transcript_torah, m.audio_path, m.ts, m.group_name
            FROM messages_fts fts
            JOIN messages m ON fts.rowid = m.id
            WHERE messages_fts MATCH ?
            AND m.deleted_at IS NULL
            ORDER BY m.ts DESC
            LIMIT ? OFFSET ?
        `).all(searchTerms, limit, offset);
    } catch {
        // Fallback LIKE search
        results = db.prepare(`
            SELECT id, question_text, transcript_torah, audio_path, ts, group_name
            FROM messages
            WHERE (question_text LIKE ? OR transcript_torah LIKE ?)
            AND deleted_at IS NULL
            ORDER BY ts DESC
            LIMIT ? OFFSET ?
        `).all(`%${q}%`, `%${q}%`, limit, offset);
    }

    db.close();

    res.json({
        query: q,
        results: results.map(r => ({
            id: r.id,
            question: r.question_text || '',
            answer: r.transcript_torah || '',
            hasAudio: !!r.audio_path,
            audioUrl: getAudioUrl(r.audio_path),
            date: r.ts ? new Date(r.ts * 1000).toISOString() : null
        })),
        total: results.length
    });
});

// =============================================================================
// API ENDPOINTS - Messages
// =============================================================================

// Messages récents
app.get('/api/messages', (req, res) => {
    const { limit = 20, page = 1, filter = 'all' } = req.query;
    const db = getDB();
    const offset = (page - 1) * limit;

    let whereClause = 'deleted_at IS NULL';
    if (filter === 'answered') whereClause += ' AND length(transcript_torah) > 50';
    if (filter === 'audio') whereClause += ' AND audio_path IS NOT NULL';

    const total = db.prepare(`SELECT COUNT(*) as n FROM messages WHERE ${whereClause}`).get().n;
    const results = db.prepare(`
        SELECT id, question_text, transcript_torah, audio_path, ts, group_name, sender_name
        FROM messages
        WHERE ${whereClause}
        ORDER BY ts DESC
        LIMIT ? OFFSET ?
    `).all(limit, offset);

    db.close();

    res.json({
        messages: results.map(r => ({
            id: r.id,
            question: r.question_text || '',
            answer: r.transcript_torah || '',
            hasAudio: !!r.audio_path,
            audioUrl: getAudioUrl(r.audio_path),
            date: r.ts ? new Date(r.ts * 1000).toISOString() : null,
            group: r.group_name || '',
            sender: r.sender_name || ''
        })),
        total,
        page: parseInt(page),
        totalPages: Math.ceil(total / limit)
    });
});

// Message unique
app.get('/api/messages/:id', (req, res) => {
    const db = getDB();
    const msg = db.prepare(`
        SELECT * FROM messages WHERE id = ? AND deleted_at IS NULL
    `).get(req.params.id);
    db.close();

    if (!msg) return res.status(404).json({ error: 'Not found' });

    res.json({
        id: msg.id,
        question: msg.question_text || '',
        answer: msg.transcript_torah || msg.transcript_raw || '',
        rawAnswer: msg.transcript_raw || '',
        hasAudio: !!msg.audio_path,
        audioUrl: getAudioUrl(msg.audio_path),
        date: msg.ts ? new Date(msg.ts * 1000).toISOString() : null,
        group: msg.group_name || '',
        sender: msg.sender_name || ''
    });
});

// =============================================================================
// API ENDPOINTS - Admin Validation / Suggestions
// =============================================================================

// Public: Proposer une modification
app.post('/api/suggestions', (req, res) => {
    const { message_id, type, payload } = req.body;
    // Basic validation
    if (!message_id || !type || !payload) {
        return res.status(400).json({ error: 'Données incomplètes' });
    }

    const db = getDB();
    try {
        const info = db.prepare(`
            INSERT INTO suggestions (message_id, type, payload, created_at, suggester_ip, status)
            VALUES (?, ?, ?, ?, ?, 'pending')
        `).run(message_id, type, JSON.stringify(payload), Math.floor(Date.now() / 1000), req.ip);

        db.close();
        res.json({ success: true, id: info.lastInsertRowid });
    } catch (e) {
        if (db) db.close();
        console.error('Submission error:', e);
        res.status(500).json({ error: e.message });
    }
});

// Admin: Lister modifications en attente
app.get('/api/admin/suggestions', requireAdmin, (req, res) => {
    const db = getDB();
    try {
        const rows = db.prepare(`
            SELECT s.*, m.question_text as current_question, m.transcript_torah as current_answer
            FROM suggestions s
            LEFT JOIN messages m ON s.message_id = m.id
            WHERE s.status = 'pending'
            ORDER BY s.created_at DESC
        `).all();
        db.close();
        res.json({ suggestions: rows });
    } catch (e) {
        if (db) db.close();
        res.status(500).json({ error: e.message });
    }
});

// Admin: Refuser une suggestion
app.post('/api/admin/suggestions/:id/reject', requireAdmin, (req, res) => {
    const db = getDB();
    try {
        db.prepare("UPDATE suggestions SET status = 'rejected' WHERE id = ?").run(req.params.id);
        db.close();
        res.json({ success: true });
    } catch (e) {
        if (db) db.close();
        res.status(500).json({ error: e.message });
    }
});

// Admin: Approuver une suggestion
app.post('/api/admin/suggestions/:id/approve', requireAdmin, (req, res) => {
    const db = getDB();
    try {
        const suggestion = db.prepare('SELECT * FROM suggestions WHERE id = ?').get(req.params.id);
        if (!suggestion) {
            db.close();
            return res.status(404).json({ error: 'Suggestion introuvable' });
        }
        if (suggestion.status !== 'pending') {
            db.close();
            return res.status(400).json({ error: 'Suggestion déjà traitée' });
        }

        const payload = JSON.parse(suggestion.payload);

        // Apply Logic
        if (suggestion.type === 'edit') {
            db.prepare(`
                UPDATE messages 
                SET question_text = ?, transcript_torah = ? 
                WHERE id = ?
            `).run(payload.question, payload.answer, suggestion.message_id);
            console.log(`✅ Admin Approved Edit on msg ${suggestion.message_id}`);
        } else if (suggestion.type === 'delete') {
            db.prepare(`
                UPDATE messages 
                SET deleted_at = ? 
                WHERE id = ?
            `).run(Math.floor(Date.now() / 1000), suggestion.message_id);
            console.log(`✅ Admin Approved Delete on msg ${suggestion.message_id}`);
        } else if (suggestion.type === 'relink') {
            // Logic handled by existing /api/relink logic but inside here
            // Simplified: just update link
            db.prepare(`
            UPDATE messages 
            SET link_question_id = ?, link_confidence = 1.0, link_method = 'manual_admin'
            WHERE id = ?
        `).run(payload.questionId, suggestion.message_id); // suggestion.message_id is the Audio ID
        }

        // Update Suggestion status
        db.prepare("UPDATE suggestions SET status = 'approved' WHERE id = ?").run(req.params.id);

        db.close();
        invalidateCache();
        res.json({ success: true });
    } catch (e) {
        if (db) db.close();
        console.error('Approve failed:', e);
        res.status(500).json({ error: e.message });
    }
});

// DEBUG: View Download Logs (Public for debugging, remove later)
app.get('/api/debug/download-logs', (req, res) => {
    const logPath = path.join(__dirname, 'download.log');
    if (fs.existsSync(logPath)) {
        const content = fs.readFileSync(logPath, 'utf8');
        res.type('text/plain').send(content);
    } else {
        res.status(404).send('Log file not found (Process might not have started or no output yet).');
    }
});

// ADMIN: Supprimer un message (Direct) - PROTECTED
app.delete('/api/messages/:id', requireAdmin, (req, res) => {
    const db = getDB();
    try {
        const info = db.prepare('UPDATE messages SET deleted_at = ? WHERE id = ?')
            .run(Math.floor(Date.now() / 1000), req.params.id);

        db.close();
        if (info.changes === 0) return res.status(404).json({ error: 'Message non trouvé' });

        console.log(`🗑️ Message ${req.params.id} supprimé (Admin Direct).`);
        invalidateCache(); // FORCE REFRESH
        res.json({ success: true });
    } catch (e) {
        db.close();
        res.status(500).json({ error: e.message });
    }
});

// ADMIN: Modifier un message (Direct) - PROTECTED
app.put('/api/messages/:id', requireAdmin, (req, res) => {
    const { question, answer } = req.body;
    const db = getDB();
    try {
        const info = db.prepare(`
            UPDATE messages 
            SET question_text = ?, transcript_torah = ?
            WHERE id = ?
        `).run(question, answer, req.params.id);

        db.close();
        if (info.changes === 0) return res.status(404).json({ error: 'Message non trouvé' });

        console.log(`✏️ Message ${req.params.id} modifié (Admin Direct).`);
        invalidateCache(); // FORCE REFRESH
        res.json({ success: true });
    } catch (e) {
        db.close();
        res.status(500).json({ error: e.message });
    }
});

// ADMIN: Relier manuellement une réponse (audio) à une question - PROTECTED
app.post('/api/relink', requireAdmin, (req, res) => {
    const { audioId, questionId } = req.body;

    // audioId = ID du message contenant l'audio/réponse
    // questionId = ID du message contenant la question

    if (!audioId || !questionId) return res.status(400).json({ error: 'IDs manquants' });

    const db = getDB();
    try {
        // Obtenir le message question pour avoir son wa_message_id si nécessaire, 
        // ou simplement lier par ID interne.
        // La colonne s'appelle link_question_id. Assumons qu'elle stocke l'ID interne pour simplifier,
        // ou le wa_message_id selon le legacy. Le legacy utilisait wa_message_id.
        // Vérifions le schéma : link_question_id est TEXT. 
        // L'ancien système liait un message AUDIO à une QUESTION via link_question_id = ID de la question.

        const qMsg = db.prepare('SELECT wa_message_id FROM messages WHERE id = ?').get(questionId);
        if (!qMsg) return res.status(404).json({ error: 'Question introuvable' });

        // Update le message audio
        const info = db.prepare(`
            UPDATE messages 
            SET link_question_id = ?, link_confidence = 1.0, link_method = 'manual'
            WHERE id = ?
        `).run(qMsg.wa_message_id, audioId);

        // Copier le texte de la question dans le message audio pour affichage facile
        const qText = db.prepare('SELECT question_text FROM messages WHERE id = ?').get(questionId).question_text;
        db.prepare('UPDATE messages SET question_text = ? WHERE id = ?').run(qText, audioId);

        db.close();
        console.log(`🔗 Relink: Audio ${audioId} -> Question ${questionId}`);
        invalidateCache();
        res.json({ success: true });
    } catch (e) {
        if (db) db.close();
        res.status(500).json({ error: e.message });
    }
});

// ADMIN: Délier un message - PROTECTED
app.post('/api/unlink', requireAdmin, (req, res) => {
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: 'ID manquant' });

    const db = getDB();
    try {
        const info = db.prepare(`
            UPDATE messages 
            SET link_question_id = NULL, link_confidence = 0, question_text = NULL
            WHERE id = ?
        `).run(id);

        db.close();
        console.log(`⛓️ Unlink: Message ${id}`);
        invalidateCache();
        res.json({ success: true });
    } catch (e) {
        if (db) db.close();
        res.status(500).json({ error: e.message });
    }
});

// (Imported at top)

// ADMIN: Trouver des candidats pour relier
app.get('/api/candidates/:id', async (req, res) => {
    // On cherche des messages TEXTE (queston) autour de la date du message AUDIO (id)
    // MISE A JOUR: Recherche sémantique prioritaire si transcription disponible
    const db = getDB();
    try {
        const target = db.prepare('SELECT ts, group_name, transcript_torah, transcript_raw FROM messages WHERE id = ?').get(req.params.id);
        if (!target) return res.status(404).json({ error: 'Message non trouvé' });

        let candidates = [];
        const textContent = target.transcript_torah || target.transcript_raw;

        // 1. RECHERCHE SÉMANTIQUE (Si texte dispo)
        if (textContent && textContent.length > 20) {
            console.log(`🔎 Finding candidates via Semantic Search for msg ${req.params.id}`);
            try {
                // On cherche tout message similaire. Les questions pertinentes auront un score élevé.
                const results = await searchLocal(textContent, 30);

                candidates = results
                    .filter(r => r.id != req.params.id) // Exclure soi-même
                    // .filter(r => !r.audio_path) // Optionnel: Prioriser les questions sans audio? Non, on veut tout voir.
                    .map(r => ({
                        id: r.id,
                        question_text: r.question, // searchLocal retourne 'question'
                        ts: r.timestamp,           // searchLocal retourne 'timestamp'
                        group_name: r.group_name,
                        sender_name: '',           // Non disponible via searchLocal pour l'instant
                        score: r.score,
                        is_semantic: true
                    }));
            } catch (e) {
                console.error('Semantic candidate search failed:', e);
            }
        }

        // 2. RECHERCHE TEMPORELLE (Fallback ou Complément si peu de résultats)
        // Chercher 48h avant (Logique originale conservee comme filet de sécurité)
        if (candidates.length < 10) {
            const window = 48 * 3600;
            const minTs = target.ts - window;
            const maxTs = target.ts; // La question est généralement AVANT la réponse

            const timeCandidates = db.prepare(`
                SELECT id, question_text, ts, group_name, sender_name 
                FROM messages 
                WHERE ts BETWEEN ? AND ?
                AND (audio_path IS NULL OR audio_path = '')
                AND length(question_text) > 5
                AND deleted_at IS NULL
                ORDER BY ts DESC
                LIMIT 20
            `).all(minTs, maxTs);

            // Fusionner sans doublons
            const existingIds = new Set(candidates.map(c => c.id));
            for (const tc of timeCandidates) {
                if (!existingIds.has(tc.id) && tc.id != req.params.id) {
                    candidates.push({ ...tc, is_semantic: false });
                }
            }
        }

        // Trier: Sémantiques d'abord, puis temporels récents
        candidates.sort((a, b) => {
            if (a.is_semantic && !b.is_semantic) return -1;
            if (!a.is_semantic && b.is_semantic) return 1;
            if (a.score && b.score) return b.score - a.score; // Score décroissant
            return b.ts - a.ts; // Date décroissante par défaut
        });

        db.close();
        res.json({ candidates });
    } catch (e) {
        if (db) db.close();
        res.status(500).json({ error: e.message });
    }
});

// =============================================================================
// API ENDPOINTS - Upload WhatsApp ZIP
// =============================================================================

// Import Redis Client
const { redisCache } = require('./redis-client');

// Upload et import ZIP WhatsApp (Asynchrone + Persistant Redis)
app.post('/api/upload', upload.single('file'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'Aucun fichier reçu' });
    }

    const jobId = `job_${Date.now()}`;
    console.log(`📦 Upload reçu: ${req.file.originalname} (Job ${jobId})`);

    // Initialiser Job dans Redis (TTL 24h)
    const initialJobState = {
        status: 'processing',
        startTime: Date.now(),
        file: req.file.originalname,
        progress: { state: 'queued', message: 'Mise en file d\'attente...' }
    };
    await redisCache.set(jobId, initialJobState, 86400); // 24h retention

    // Lancer en background
    importWhatsAppZip(req.file.path, async (progress) => {
        // Mise à jour temps réel du Job dans Redis
        const currentJob = await redisCache.get(jobId);
        if (currentJob) {
            currentJob.progress = progress;
            currentJob.lastUpdate = Date.now();
            await redisCache.set(jobId, currentJob, 86400);
        }
    })
        .then(async result => {
            console.log(`✅ Job ${jobId} terminé: ${result.imported || 0} messages`);
            const currentJob = await redisCache.get(jobId) || initialJobState;
            currentJob.status = 'completed';
            currentJob.result = result;
            currentJob.completedAt = Date.now();
            await redisCache.set(jobId, currentJob, 86400);

            fs.unlink(req.file.path, () => { }); // Cleanup
        })
        .catch(async error => {
            console.error(`❌ Job ${jobId} erreur:`, error);
            const currentJob = await redisCache.get(jobId) || initialJobState;
            currentJob.status = 'error';
            currentJob.error = error.message;
            await redisCache.set(jobId, currentJob, 86400);

            fs.unlink(req.file.path, () => { }); // Cleanup
        });

    // Répondre immédiatement
    res.json({
        success: true,
        jobId: jobId,
        message: 'Import démarré en arrière-plan (sécurisé par Redis)'
    });
});

// Status Job Import (Lecture Redis)
app.get('/api/upload/status/:jobId', async (req, res) => {
    try {
        const job = await redisCache.get(req.params.jobId);
        if (!job) return res.status(404).json({ error: 'Job non trouvé ou expiré' });
        res.json(job);
    } catch (e) {
        res.status(500).json({ error: 'Erreur lecture Redis' });
    }
});

// Status des imports en cours (pour les gros fichiers)
let importStatus = { active: false, progress: 0, filename: null };

app.get('/api/upload/status', (req, res) => {
    res.json(importStatus);
});

// =============================================================================
// VISITOR TRACKING
// =============================================================================

// Increment visit (called by frontend)
app.post('/api/visit', (req, res) => {
    const today = new Date().toISOString().split('T')[0];
    const db = getDB();
    try {
        // Upsert daily count
        db.prepare(`
            INSERT INTO visitor_stats (date, count) VALUES (?, 1)
            ON CONFLICT(date) DO UPDATE SET count = count + 1
        `).run(today);

        // Optional: Log detailed visit (limit to last 1000 to save space if needed, or just insert)
        // For privacy/simplicity, we just count.

        res.json({ success: true });
    } catch (e) {
        console.error('Visit track error:', e);
        res.status(500).json({ error: 'Track failed' });
    } finally {
        db.close();
    }
});

// Get total visits (for admin)
app.get('/api/admin/visits', (req, res) => {
    const db = getDB();
    try {
        const row = db.prepare('SELECT SUM(count) as total FROM visitor_stats').get();
        const todayRow = db.prepare('SELECT count FROM visitor_stats WHERE date = ?').get(new Date().toISOString().split('T')[0]);

        res.json({
            total: row.total || 0,
            today: todayRow ? todayRow.count : 0
        });
    } catch (e) {
        res.status(500).json({ error: 'Stats failed' });
    } finally {
        db.close();
    }
});

// =============================================================================
// API ENDPOINTS - Feedback / Validation (Robust System)
// =============================================================================

const { setupFeedbackEndpoints } = require('./feedback_system');
setupFeedbackEndpoints(app, invalidateCache);

// =============================================================================
// RAG SEMANTIC SEARCH (Qdrant + OpenAI Embeddings)
// =============================================================================

setupRAGEndpoints(app);

// =============================================================================
// AI ASSISTANT (GPT + Sources)
// =============================================================================

setupAIAssistantEndpoints(app);

// =============================================================================
// PSAK NET - Politique de décision à 3 verdicts (voir PSAK_NET_SPEC.md)
// =============================================================================

const { setupPsakEndpoints } = require('./psak_net/routes');
setupPsakEndpoints(app);

// =============================================================================
// SPA - Serve frontend (MUST BE LAST - catch-all)
// =============================================================================

// Fallback to index.html for SPA
app.use((req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// =============================================================================
// START SERVER
// =============================================================================

// --- MIDDLEWARE DE GESTION D'ERREURS CENTRALISÉ ---
app.use((err, req, res, next) => {
    console.error('🔥 Erreur Serveur:', err.stack);

    // Distinguer erreurs opérationnelles vs bugs
    const statusCode = err.statusCode || 500;
    const message = statusCode === 500 ? 'Erreur interne du serveur' : err.message;

    res.status(statusCode).json({
        success: false,
        error: message,
        timestamp: new Date().toISOString()
    });
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🚀 RavQA Server v2.0`);
    console.log(`📍 http://0.0.0.0:${PORT} (Railway/Cloud bound)`);
    console.log(`📂 Database: ${DB_PATH}`);
    console.log(`🧠 RAG Search: http://0.0.0.0:${PORT}/api/rag-search\n`);
});

module.exports = app;
