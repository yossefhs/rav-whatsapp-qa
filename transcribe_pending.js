/**
 * Service de Transcription en Arrière-plan (Background Worker)
 * Scanne la base de données pour les audios sans transcription et les complète.
 * 
 * Usage: node transcribe_pending.js
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const OpenAI = require('openai');

// Config
const DB_PATH = process.env.DB_PATH || './ravqa.db';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!OPENAI_API_KEY) {
    console.error('❌ Erreur: OPENAI_API_KEY manquant dans .env');
    process.exit(1);
}

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const db = new Database(DB_PATH);

async function transcribeAudio(audioPath) {
    try {
        if (!fs.existsSync(audioPath)) return null;

        const transcription = await openai.audio.transcriptions.create({
            file: fs.createReadStream(audioPath),
            model: "whisper-1",
            language: "fr"
        });
        return transcription.text;
    } catch (e) {
        console.error(`  ❌ Erreur API: ${e.message}`); // Ex: Rate limit, quota
        return null;
    }
}

async function runBatch() {
    console.log('🔍 Recherche des audios manquants...');

    // 1. Récupérer les messages avec audio mais SANS transcription (ou vide)
    // FILTRE: UNIQUEMENT LE RAV (Michael Abichid)
    const messages = db.prepare(`
        SELECT id, audio_path 
        FROM messages 
        WHERE audio_path IS NOT NULL 
        AND (transcript_torah IS NULL OR length(transcript_torah) < 5)
        AND sender_name = 'Michael Abichid'
        ORDER BY ts DESC
    `).all();

    const total = messages.length;
    console.log(`📋 Trouvé ${total} audios à transcrire (Filtre: Michael Abichid).\n`);

    if (total === 0) {
        console.log('✅ Tout est à jour !');
        return;
    }

    let successes = 0;
    let errors = 0;
    let skipped = 0;

    // 2. Traiter séquentiellement (pour éviter rate limit)
    for (let i = 0; i < total; i++) {
        const msg = messages[i];

        // Progress Bar simple
        const percent = Math.round(((i + 1) / total) * 100);
        process.stdout.write(`\r[${percent}%] (${i + 1}/${total}) Traitement ID ${msg.id}... `);

        // Vérif fichier
        if (!msg.audio_path || !fs.existsSync(msg.audio_path)) {
            process.stdout.write('⚠️ Fichier introuvable');
            skipped++;
            continue;
        }

        // Vérif extension (Whisper ne prend pas les images !)
        const ext = path.extname(msg.audio_path).toLowerCase();
        const validExtensions = ['.flac', '.m4a', '.mp3', '.mp4', '.mpeg', '.mpga', '.oga', '.ogg', '.wav', '.webm', '.opus'];

        if (!validExtensions.includes(ext)) {
            process.stdout.write(`⚠️ Format invalide (${ext}) - Skipped`);
            skipped++;
            continue;
        }

        // WORKAROUND: OpenAI refuse .opus officiellement, mais accepte si on renforce en .ogg
        let fileToSend = msg.audio_path;
        let tempFile = null;

        if (ext === '.opus') {
            tempFile = msg.audio_path.replace(/\.opus$/i, '.ogg');
            // Si le fichier .ogg n'existe pas déjà (cas import doubles), on le crée temporairement
            // Utilisation de copyFile pour compatibilité max (symlink parfois capricieux sur API)
            try {
                if (!fs.existsSync(tempFile)) {
                    fs.copyFileSync(msg.audio_path, tempFile);
                } else {
                    tempFile = null; // On ne touche pas s'il existe déjà
                }
            } catch (e) {
                tempFile = null; // Fallback sur original
            }
            if (tempFile) fileToSend = tempFile;
        }

        // Transcrire
        const text = await transcribeAudio(fileToSend);

        // Nettoyage temp
        if (tempFile && fs.existsSync(tempFile)) {
            try { fs.unlinkSync(tempFile); } catch (e) { }
        }

        if (text) {
            // Update DB
            db.prepare(`
                UPDATE messages 
                SET transcript_torah = ?, transcript_raw = ? 
                WHERE id = ?
            `).run(text, text, msg.id);

            process.stdout.write('✅ Sauvegardé');
            successes++;
        } else {
            console.log('\n  ❌ Échec transcription');
            errors++;
        }
    }

    console.log('\n\n🏁 Terminé !');
    console.log(`✅ Succès: ${successes}`);
    console.log(`❌ Erreurs: ${errors}`);
    console.log(`⚠️ Skipped: ${skipped}`);
}

// Gestion Arrêt Propre (Ctrl+C)
process.on('SIGINT', () => {
    console.log('\n\n🛑 Arrêt demandé. Fermeture DB...');
    db.close();
    process.exit();
});

// Lancer
runBatch();
