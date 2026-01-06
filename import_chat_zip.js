#!/usr/bin/env node
/**
 * Import WhatsApp Chat Export ZIP - Version 3.0 (Smart Import)
 * - Détection Doublons (MD5 Hash)
 * - Transcription Automatique (OpenAI Whisper)
 * - Liaison Audio Stricte
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const OpenAI = require('openai');

const DB_PATH = process.env.DB_PATH || './ravqa.db';
const MEDIA_DIR = process.env.MEDIA_DIR || './media';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
let openai = null;

function getOpenAI() {
    if (!openai && OPENAI_API_KEY) {
        openai = new OpenAI({ apiKey: OPENAI_API_KEY });
    }
    return openai;
}

// =============================================================================
// PARSERS
// =============================================================================

const LINE_PARSERS = [
    /^\[(\d{2}\/\d{2}\/\d{4}),\s*(\d{2}:\d{2}:\d{2})\]\s*([^:]+):\s*(.*)$/, // Android
    /^(\d{2}\/\d{2}\/\d{4}),\s*(\d{2}:\d{2})\s*-\s*([^:]+):\s*(.*)$/,       // iOS
    /^(\d{2}\/\d{2}\/\d{4})\s+(\d{2}:\d{2}:\d{2}):\s*([^:]+):\s*(.*)$/,      // FR
    /^‎?(\d{2}\/\d{2}\/\d{4}),?\s*(\d{2}:\d{2}(?::\d{2})?)\s*[-:]?\s*([^:]+):\s*(.*)$/, // Invisible char
    /^(\d{1,2}\/\d{1,2}\/\d{4}),\s*(\d{1,2}:\d{2}\s*(?:AM|PM)?)\s*-\s*([^:]+):\s*(.*)$/i // US
];

function parseWhatsAppLine(line) {
    line = line.replace(/[\u200E\u200F\u202A-\u202E\uFEFF]/g, '').trim();
    for (const regex of LINE_PARSERS) {
        const match = line.match(regex);
        if (match) {
            let [, dateStr, timeStr, sender, message] = match;

            // Date parsing simplifiée pour MVP
            let day, month, year;
            if (dateStr.includes('/')) [day, month, year] = dateStr.split('/');
            else if (dateStr.includes('-')) [day, month, year] = dateStr.split('-');
            if (year && year.length === 2) year = '20' + year;

            let time = timeStr;

            try {
                // Essai parsing date standard ISO
                const dt = new Date(year + '-' + month + '-' + day + 'T' + time.replace(',', ''));
                if (isNaN(dt.getTime())) continue; // Skip invalid dates

                return {
                    timestamp: Math.floor(dt.getTime() / 1000),
                    sender: sender.trim(),
                    message: message.trim()
                };
            } catch (e) { continue; }
        }
    }
    return null;
}

// =============================================================================
// UTILS
// =============================================================================

function generateMessageHash(timestamp, sender, content) {
    return crypto.createHash('md5')
        .update(`${timestamp}|${sender}|${content}`)
        .digest('hex');
}

function isAudioReference(message) {
    return /\.(opus|ogg|mp3|m4a|wav|aac)/i.test(message) ||
        /PTT-\d+/i.test(message) ||
        /<Média omis>/i.test(message) ||
        /<fichier joint>/i.test(message);
}

function extractAudioFilename(message) {
    const match = message.match(/([\w-]+\.(opus|ogg|mp3|m4a|wav))/i);
    return match ? match[1] : null;
}

function findAudioFiles(dir) {
    const audioFiles = {};
    function walkDir(currentDir) {
        const entries = fs.readdirSync(currentDir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(currentDir, entry.name);
            if (entry.isDirectory()) walkDir(fullPath);
            else if (/\.(opus|ogg|mp3|m4a|wav|aac)$/i.test(entry.name)) {
                audioFiles[entry.name.toLowerCase()] = fullPath;
            }
        }
    }
    walkDir(dir);
    return audioFiles;
}

// =============================================================================
// TRANSCRIPTION
// =============================================================================

async function transcribeAudio(audioPath) {
    const ai = getOpenAI();
    if (!ai) return null; // Pas de clé API = pas de transcription

    try {
        console.log(`🎙️ Transcription de ${path.basename(audioPath)}...`);
        const transcription = await ai.audio.transcriptions.create({
            file: fs.createReadStream(audioPath),
            model: "whisper-1",
            language: "fr" // Optimisation pour français
        });
        return transcription.text;
    } catch (e) {
        console.error(`❌ Erreur transcription: ${e.message}`);
        return null;
    }
}

// =============================================================================
// MAIN IMPORT
// =============================================================================

async function importWhatsAppZip(zipPath, onProgress = () => { }) {
    console.log('\n📦 === IMPORT WHATSAPP V3 (SMART) ===\n');
    console.log('Fichier:', zipPath);

    if (!fs.existsSync(zipPath)) return { success: false, error: 'Fichier introuvable' };

    onProgress({ state: 'extracting', message: 'Extraction du fichier ZIP...' });

    // 1. Extraction
    let zip, tempDir;
    try {
        zip = new AdmZip(zipPath);
        tempDir = path.join(__dirname, 'temp_import_' + Date.now());
        zip.extractAllTo(tempDir, true);
    } catch (e) {
        return { success: false, error: 'ZIP invalide: ' + e.message };
    }

    // 2. Scan fichiers
    onProgress({ state: 'scanning', message: 'Analyse des fichiers multimédias...' });
    const audioFiles = findAudioFiles(tempDir);

    // Trouver chat.txt
    let chatFile = null;
    function findChat(dir) {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.isDirectory()) {
                const found = findChat(path.join(dir, entry.name));
                if (found) return found;
            } else if (entry.name.endsWith('.txt') && !entry.name.startsWith('.')) {
                return path.join(dir, entry.name);
            }
        }
        return null;
    }
    chatFile = findChat(tempDir);

    if (!chatFile) {
        fs.rmSync(tempDir, { recursive: true });
        return { success: false, error: 'Aucun fichier .txt trouvé' };
    }

    // 3. Parsing
    onProgress({ state: 'parsing', message: 'Lecture de la conversation...' });
    const content = fs.readFileSync(chatFile, 'utf-8');
    const lines = content.split('\n');
    const db = new Database(DB_PATH);

    let stats = { imported: 0, skipped_dup: 0, audio_linked: 0, transcribed: 0, errors: 0 };
    let currentQuestion = null;

    if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR, { recursive: true });

    // Préparer statements
    const checkStmt = db.prepare('SELECT id FROM messages WHERE wa_message_id = ?');
    const insertStmt = db.prepare(`
        INSERT INTO messages (wa_message_id, group_name, sender_name, ts, question_text, audio_path, transcript_raw)
        VALUES (@id, @group, @sender, @ts, @question, @audio, @transcript)
    `);

    onProgress({
        state: 'processing',
        message: 'Import des messages...',
        total: lines.length,
        processed: 0
    });

    // Traitement séquentiel pour transcription
    let processedCount = 0;

    for (const line of lines) {
        processedCount++;
        // Mise à jour progression tous les 50 messages
        if (processedCount % 50 === 0) {
            onProgress({
                state: 'processing',
                message: `Traitement ligne ${processedCount}/${lines.length}...`,
                total: lines.length,
                processed: processedCount,
                stats
            });
        }

        const parsed = parseWhatsAppLine(line);
        if (!parsed) continue;

        const { timestamp, sender, message } = parsed;

        // Skip systems
        if (sender.includes('ajouté') || sender.toLowerCase().includes('system') || message.includes('chiffrement')) continue;

        // Générer ID Unique (Deduplication)
        const waId = generateMessageHash(timestamp, sender, message);

        // Check doublon
        const existing = checkStmt.get(waId);
        if (existing) {
            stats.skipped_dup++;
            continue;
        }

        let audioPath = null;
        let transcript = null;
        let isAudio = isAudioReference(message);

        // Traitement Audio
        if (isAudio) {
            const filename = extractAudioFilename(message);
            if (filename && audioFiles[filename.toLowerCase()]) {
                const source = audioFiles[filename.toLowerCase()];
                const destName = `import_${waId}_${filename}`; // ID unique dans nom fichier
                const dest = path.join(MEDIA_DIR, destName);

                fs.copyFileSync(source, dest);
                audioPath = dest;
                stats.audio_linked++;

                // Transcription Whisper !
                if (OPENAI_API_KEY) {
                    onProgress({
                        state: 'transcribing',
                        message: `Transcription audio (${stats.transcribed + 1})...`,
                        total: lines.length,
                        processed: processedCount,
                        stats
                    });

                    transcript = await transcribeAudio(dest);
                    if (transcript) stats.transcribed++;
                }
            } else {
                // Audio introuvable -> on stocke quand même le message textuel placeholder
            }
        }

        // Déterminer question contextuelle (si c'est une réponse audio)
        let questionText = null;
        if (isAudio && currentQuestion) {
            questionText = currentQuestion; // Lie à la question précédente
            currentQuestion = null; // Reset
        } else if (!isAudio && message.length > 5) {
            currentQuestion = message; // Devient la question potentielle pour le prochain audio
            questionText = message; // C'est aussi une question en soi (ou un message texte)
        }

        // Insertion
        try {
            insertStmt.run({
                id: waId,
                group: 'Import WhatsApp',
                sender: sender,
                ts: timestamp,
                question: questionText || (isAudio ? 'Réponse audio' : message),
                audio: audioPath,
                transcript: transcript
            });
            stats.imported++;
        } catch (e) {
            console.error('Insert Error:', e.message);
            stats.errors++;
        }
    }

    db.close();
    fs.rmSync(tempDir, { recursive: true });

    return { success: true, ...stats };
}

// CLI Support
if (require.main === module) {
    const zip = process.argv[2];
    if (zip) importWhatsAppZip(zip).then(console.log).catch(console.error);
    else console.log('Usage: node import_chat_zip.js <file.zip>');
}

module.exports = { importWhatsAppZip };
