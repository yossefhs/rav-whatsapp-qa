#!/usr/bin/env node
/**
 * Indexation V3 — embeddings de la QUESTION SEULE (prérequis du Verdict A).
 *
 * Pourquoi : l'index actuel (message_embeddings) encode question+réponse
 * fusionnées ; comparer une nouvelle question à ces vecteurs dilue le signal
 * et le seuil 0.90 du Psak Net devient inatteignable. Ici on indexe la
 * question d'origine seule, dans une table dédiée `question_embeddings`.
 *
 * La question retenue suit la même hiérarchie de preuve que psak_net/candidats.js :
 * reply > lien algorithmique > question_text propre.
 *
 * Usage : OPENAI_API_KEY=... DB_PATH=./ravqa.db node scripts/index_questions_v3.js
 */
require('dotenv').config();
const Database = require('better-sqlite3');
const OpenAI = require('openai');

const DB_PATH = process.env.DB_PATH || './ravqa.db';
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function getEmbedding(text) {
    const r = await openai.embeddings.create({
        model: 'text-embedding-3-small',
        input: text.substring(0, 8000),
    });
    return r.data[0].embedding;
}

async function indexQuestions() {
    const db = new Database(DB_PATH);
    db.exec(`CREATE TABLE IF NOT EXISTS question_embeddings (
        id INTEGER PRIMARY KEY,      -- id du message-réponse (audio)
        question TEXT,               -- la question d'origine retenue
        source TEXT,                 -- 'reply' | 'link' | 'own_question_text'
        vector TEXT
    )`);

    // Toutes les réponses exploitables avec une question identifiable
    const rows = db.prepare(`
        SELECT a.id,
               COALESCE(qr.question_text, ql1.question_text, ql2.question_text,
                        CASE WHEN a.question_text != 'audio omis' THEN a.question_text END) AS question,
               CASE WHEN qr.question_text IS NOT NULL THEN 'reply'
                    WHEN COALESCE(ql1.question_text, ql2.question_text) IS NOT NULL THEN 'link'
                    ELSE 'own_question_text' END AS source
        FROM messages a
        LEFT JOIN messages qr  ON qr.wa_message_id = a.replied_to_message_id
                               AND qr.question_text IS NOT NULL AND trim(qr.question_text) != ''
        LEFT JOIN messages ql1 ON ql1.id = a.link_question_id
                               AND ql1.question_text IS NOT NULL AND trim(ql1.question_text) != ''
        LEFT JOIN messages ql2 ON ql2.wa_message_id = a.link_question_id
                               AND ql2.question_text IS NOT NULL AND trim(ql2.question_text) != ''
        WHERE a.deleted_at IS NULL
          AND a.audio_path IS NOT NULL AND a.audio_path != ''
          AND length(COALESCE(NULLIF(a.transcript_torah,''), a.transcript_raw)) >= 20
    `).all().filter(r => r.question && r.question.trim().length >= 10);

    // Skip déjà indexés (relançable sans coût)
    const done = new Set(db.prepare('SELECT id FROM question_embeddings').all().map(r => r.id));
    const todo = rows.filter(r => !done.has(r.id));
    console.log(`📊 ${rows.length} questions identifiables, ${todo.length} à indexer (${done.size} déjà faites)`);

    const insert = db.prepare('INSERT OR REPLACE INTO question_embeddings (id, question, source, vector) VALUES (?,?,?,?)');
    let ok = 0, err = 0;
    const BATCH = 20;
    for (let i = 0; i < todo.length; i += BATCH) {
        await Promise.all(todo.slice(i, i + BATCH).map(async (r) => {
            try {
                const v = await getEmbedding(r.question.trim());
                insert.run(r.id, r.question.trim(), r.source, JSON.stringify(v));
                ok++;
            } catch (e) { err++; console.error(`id ${r.id}:`, e.message); }
        }));
        process.stdout.write(`\r📦 ${ok}/${todo.length} (err: ${err})`);
        await new Promise(res => setTimeout(res, 200)); // anti rate-limit
    }
    console.log(`\n✅ Terminé : ${ok} vecteurs question-seule dans question_embeddings.`);
    db.close();
}

indexQuestions().catch(e => { console.error(e); process.exit(1); });
