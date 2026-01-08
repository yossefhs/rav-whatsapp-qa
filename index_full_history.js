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
const QDRANT_URL = process.env.QDRANT_URL || 'http://localhost:6333';
const COLLECTION = 'halakhic_qa';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

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

// Upsert points Qdrant
async function upsertPoints(points) {
    const response = await fetch(`${QDRANT_URL}/collections/${COLLECTION}/points?wait=true`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ points })
    });
    return response.json();
}

async function indexAll() {
    console.log('🚀 Indexation Complète Historique → Qdrant\n');

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

    // 2. Sélectionner les Q&A textuels liés (Link manuel)
    const queryLinked = `
        SELECT a.id, 
               q.question_text as linked_question,
               a.question_text as transcript_raw, 
               NULL as transcript_torah,
               NULL as audio_path,
               a.group_name,
               a.ts,
               a.sender_name
        FROM messages a
        JOIN messages q ON a.link_question_id = q.id
        WHERE a.deleted_at IS NULL
        AND a.question_text IS NOT NULL 
        AND length(a.question_text) > 20
        AND length(q.question_text) > 10
    `;

    // 3. Sélectionner les Q&A liés par Reply (WhatsApp Reply)
    const queryReplies = `
        SELECT a.id, 
               q.question_text as linked_question,
               a.question_text as transcript_raw,
               NULL as transcript_torah,
               NULL as audio_path,
               a.group_name,
               a.ts,
               a.sender_name
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

    console.log(`📊 ${rowsTranscribed.length} messages transcrits trouvés`);
    console.log(`📊 ${rowsLinked.length} messages liés (manuel) trouvés`);
    console.log(`📊 ${rowsReplies.length} messages liés (reply) trouvés`);

    // Fusionner en évitant les doublons
    const allRows = [...rowsTranscribed];
    const existingIds = new Set(rowsTranscribed.map(r => r.id));

    for (const row of rowsLinked) {
        if (!existingIds.has(row.id)) {
            allRows.push(row);
            existingIds.add(row.id);
        }
    }

    for (const row of rowsReplies) {
        if (!existingIds.has(row.id)) {
            allRows.push(row);
            existingIds.add(row.id);
        }
    }

    // Trier par date
    const rows = allRows.sort((a, b) => b.ts - a.ts);

    console.log(`📊 Total candidats à l'indexation: ${rows.length}\n`);

    if (rows.length === 0) {
        console.log('❌ Aucun message à indexer');
        return;
    }

    const BATCH_SIZE = 50;
    let processed = 0;
    let errors = 0;
    let skipped = 0;

    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
        const batch = rows.slice(i, i + BATCH_SIZE);
        const points = [];

        await Promise.all(batch.map(async (row) => {
            try {
                // Choisir la meilleure réponse
                const answer = row.transcript_torah || row.transcript_raw;

                // Ignorer messages systèmes ou inutiles
                if (!answer || answer.includes('audio omis') || answer.includes('image absente')) {
                    skipped++;
                    return;
                }

                // Texte combiné pour l'embedding
                // Pour les messages liés, la question est dans linked_question
                const question = row.linked_question || row.question_text || '';

                const textToEmbed = [
                    question,
                    answer
                ].join('\n\n');

                if (textToEmbed.length < 30) {
                    skipped++;
                    return;
                }

                const vector = await getEmbedding(textToEmbed);
                if (!vector) {
                    errors++;
                    return;
                }

                points.push({
                    id: row.id,
                    vector: vector,
                    payload: {
                        question: question,
                        answer: answer,
                        audio_path: row.audio_path || null,
                        group_name: row.group_name || '',
                        timestamp: row.ts,
                        sender: row.sender_name || '',
                        has_torah: !!row.transcript_torah
                    }
                });
            } catch (err) {
                console.error(`Erreur process ID ${row.id}:`, err.message);
                errors++;
            }
        }));

        if (points.length > 0) {
            await upsertPoints(points);
            processed += points.length;
        }

        process.stdout.write(`\r📦 Progress: ${processed}/${rows.length} (Skipped: ${skipped}, Err: ${errors})`);

        // Petit délai pour API
        await new Promise(r => setTimeout(r, 200));
    }

    console.log(`\n\n✅ Indexation terminée: ${processed} messages indexés.`);

    // Vérif finale
    const check = await fetch(`${QDRANT_URL}/collections/${COLLECTION}`);
    const info = await check.json();
    console.log(`📊 Total Qdrant: ${info.result?.points_count || 0} points`);

    db.close();
}

indexAll().catch(console.error);
