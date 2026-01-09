#!/usr/bin/env node
/**
 * Indexation Complète Historique → Qdrant
 * Indexe TOUS les messages :
 * 1. Transcriptions (Torah/Raw)
 * 2. Questions liées (link_question_id)
 * 3. Questions répondues (replied_to_message_id)
 */
require('dotenv').config();
const Database = require('better-sqlite3');
const OpenAI = require('openai');

const DB_PATH = process.env.DB_PATH || './ravqa.db';
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Création de la table si elle n'existe pas
const db = new Database(DB_PATH);
db.exec(`
    CREATE TABLE IF NOT EXISTS message_embeddings (
        id INTEGER PRIMARY KEY,
        vector TEXT
    )
`);
db.close();

// Obtenir embedding via OpenAI
async function getEmbedding(text) {
    try {
        const response = await openai.embeddings.create({
            model: 'text-embedding-3-small',
            input: text.substring(0, 8000)
        });
        return response.data[0].embedding;
    } catch (e) {
        console.error('Erreur Embedding:', e.message);
        return null;
    }
}

async function indexAll() {
    console.log('🚀 Indexation Locale (SQLite) \n');

    const db = new Database(DB_PATH);

    // 1. Sélectionner tous les messages "utiles" (Transcrits)
    const queryTranscribed = `
        SELECT id, question_text, transcript_torah, transcript_raw, 
               audio_path, group_name, ts, sender_name,
               NULL as linked_question
        FROM messages 
        WHERE deleted_at IS NULL
        AND (
            (transcript_torah IS NOT NULL AND length(transcript_torah) > 20)
            OR 
            (transcript_raw IS NOT NULL AND length(transcript_raw) > 20)
        )
        AND (question_text IS NOT NULL AND question_text != 'audio omis')
    `;

    // 2. Messages liés manuellement
    const queryLinked = `
        SELECT a.id, 
               q.question_text as linked_question,
               a.question_text as transcript_raw, 
               NULL as transcript_torah,
               NULL as audio_path,
               a.group_name, a.ts, a.sender_name
        FROM messages a
        JOIN messages q ON a.link_question_id = q.id
        WHERE a.deleted_at IS NULL
        AND a.question_text IS NOT NULL 
        AND length(a.question_text) > 20
        AND length(q.question_text) > 10
    `;

    // 3. Messages liés par Reply
    const queryReplies = `
        SELECT a.id, 
               q.question_text as linked_question,
               a.question_text as transcript_raw,
               NULL as transcript_torah,
               NULL as audio_path,
               a.group_name, a.ts, a.sender_name
        FROM messages a
        JOIN messages q ON a.replied_to_message_id = q.wa_message_id
        WHERE a.deleted_at IS NULL
        AND a.question_text IS NOT NULL 
        AND length(a.question_text) > 20
        AND length(q.question_text) > 10
    `;

    const rowsTranscribed = db.prepare(queryTranscribed).all();
    const rowsLinked = db.prepare(queryLinked).all();
    const rowsReplies = db.prepare(queryReplies).all();

    console.log(`📊 ${rowsTranscribed.length} messages transcrits`);
    console.log(`📊 ${rowsLinked.length} messages liés (manuel)`);
    console.log(`📊 ${rowsReplies.length} messages liés (reply)`);

    // Fusion
    const allRows = [...rowsTranscribed];
    const existingIds = new Set(rowsTranscribed.map(r => r.id));

    [...rowsLinked, ...rowsReplies].forEach(row => {
        if (!existingIds.has(row.id)) {
            allRows.push(row);
            existingIds.add(row.id);
        }
    });

    console.log(`📊 Total à indexer: ${allRows.length}\n`);

    if (allRows.length === 0) {
        console.log('❌ Rien à indexer');
        return;
    }

    const insertStmt = db.prepare('INSERT OR REPLACE INTO message_embeddings (id, vector) VALUES (?, ?)');

    let processed = 0;
    let errors = 0;
    let skipped = 0;

    // Traitement par lot pour économiser mémoire
    const BATCH_SIZE = 20;

    for (let i = 0; i < allRows.length; i += BATCH_SIZE) {
        const batch = allRows.slice(i, i + BATCH_SIZE);

        await Promise.all(batch.map(async (row) => {
            try {
                // Vérifier si déjà indexé récemment ? (Optionnel, ici on force update)
                // const existing = db.prepare('SELECT id FROM message_embeddings WHERE id = ?').get(row.id);
                // if (existing) return; 

                const answer = row.transcript_torah || row.transcript_raw;
                if (!answer || answer.includes('audio omis')) {
                    skipped++;
                    return;
                }

                const question = row.linked_question || row.question_text || '';
                const textToEmbed = [question, answer].join('\n\n');

                if (textToEmbed.length < 20) {
                    skipped++;
                    return;
                }

                const vector = await getEmbedding(textToEmbed);
                if (vector) {
                    insertStmt.run(row.id, JSON.stringify(vector));
                    processed++;
                } else {
                    errors++;
                }
            } catch (err) {
                console.error(`Err ID ${row.id}:`, err.message);
                errors++;
            }
        }));

        process.stdout.write(`\r📦 ${processed}/${allRows.length} (Skip: ${skipped}, Err: ${errors})`);

        // Anti Rate Limit
        await new Promise(r => setTimeout(r, 200));
    }

    console.log(`\n\n✅ Indexation terminée: ${processed} vecteurs stockés dans SQLite.`);
    db.close();
}

indexAll().catch(console.error);
