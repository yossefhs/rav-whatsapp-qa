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
const { setupRAGEndpoints, invalidateCache } = require('./rag_api');

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
const app = express();
const { initBot } = require('./bot'); // Import Bot

// Lancement du Bot (DÉSACTIVÉ TEMPORAIREMENT POUR SILENCE)
// initBot().catch(err => console.error('❌ Bot Init Error:', err));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/audio', express.static(path.join(__dirname, 'media')));

// =============================================================================
// DATABASE HELPER
// =============================================================================

function getDB() {
    return new Database(DB_PATH);
}

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
        uptime: Math.floor(process.uptime())
    });
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
            audioUrl: r.audio_path ? `/audio/${path.basename(r.audio_path)}` : null,
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
            audioUrl: r.audio_path ? `/audio/${path.basename(r.audio_path)}` : null,
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
        audioUrl: msg.audio_path ? `/audio/${path.basename(msg.audio_path)}` : null,
        date: msg.ts ? new Date(msg.ts * 1000).toISOString() : null,
        group: msg.group_name || '',
        sender: msg.sender_name || ''
    });
});

// ADMIN: Supprimer un message (Soft Delete)
app.delete('/api/messages/:id', (req, res) => {
    const db = getDB();
    try {
        const info = db.prepare('UPDATE messages SET deleted_at = ? WHERE id = ?')
            .run(Math.floor(Date.now() / 1000), req.params.id);

        db.close();
        if (info.changes === 0) return res.status(404).json({ error: 'Message non trouvé' });

        console.log(`🗑️ Message ${req.params.id} supprimé.`);
        invalidateCache(); // FORCE REFRESH
        res.json({ success: true });
    } catch (e) {
        db.close();
        res.status(500).json({ error: e.message });
    }
});

// ADMIN: Modifier un message
app.put('/api/messages/:id', (req, res) => {
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

        console.log(`✏️ Message ${req.params.id} modifié.`);
        invalidateCache(); // FORCE REFRESH
        res.json({ success: true });
    } catch (e) {
        db.close();
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
// API ENDPOINTS - Feedback / Validation
// =============================================================================

app.post('/api/feedback', express.json(), (req, res) => {
    const { messageId, isValid, timestamp } = req.body;

    if (!messageId) {
        return res.status(400).json({ error: 'messageId requis' });
    }

    try {
        const db = new Database(DB_PATH);

        // Créer la table si elle n'existe pas
        db.exec(`
            CREATE TABLE IF NOT EXISTS feedback (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                message_id INTEGER,
                is_valid BOOLEAN,
                created_at TEXT,
                FOREIGN KEY (message_id) REFERENCES messages(id)
            )
        `);

        // Insérer le feedback
        db.prepare(`
            INSERT INTO feedback (message_id, is_valid, created_at)
            VALUES (?, ?, ?)
        `).run(messageId, isValid ? 1 : 0, timestamp || new Date().toISOString());

        db.close();

        console.log(`✅ Feedback: message ${messageId} - ${isValid ? '👍' : '👎'}`);

        res.json({ success: true });
    } catch (error) {
        console.error('Erreur feedback:', error);
        res.status(500).json({ error: 'Erreur enregistrement feedback' });
    }
});

// Stats feedback
app.get('/api/feedback/stats', (req, res) => {
    try {
        const db = new Database(DB_PATH);
        const stats = db.prepare(`
            SELECT 
                COUNT(*) as total,
                SUM(CASE WHEN is_valid = 1 THEN 1 ELSE 0 END) as valid,
                SUM(CASE WHEN is_valid = 0 THEN 1 ELSE 0 END) as invalid
            FROM feedback
        `).get();
        db.close();

        res.json(stats || { total: 0, valid: 0, invalid: 0 });
    } catch (error) {
        res.json({ total: 0, valid: 0, invalid: 0 });
    }
});

// =============================================================================
// RAG SEMANTIC SEARCH (Qdrant + OpenAI Embeddings)
// =============================================================================

setupRAGEndpoints(app);

// =============================================================================
// AI ASSISTANT (GPT + Sources)
// =============================================================================

setupAIAssistantEndpoints(app);

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

app.listen(PORT, () => {
    console.log(`\n🚀 RavQA Server v2.0`);
    console.log(`📍 http://localhost:${PORT}`);
    console.log(`📂 Database: ${DB_PATH}`);
    console.log(`🧠 RAG Search: http://localhost:${PORT}/api/rag-search\n`);
});

module.exports = app;
