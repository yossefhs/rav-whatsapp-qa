/**
 * Hydrateur de candidats pour le moteur Psak Net.
 *
 * Transforme des résultats de recherche (id + score) en candidats complets
 * exigés par psak_engine : question d'origine, réponse, audio, fiabilité du lien.
 *
 * Sémantique de la question d'origine (par ordre de preuve) :
 *   1. reply WhatsApp direct (replied_to_message_id)      → linkMethod 'reply' (prouvé)
 *   2. lien algorithmique (link_question_id, id OU wa_id) → link_method + link_confidence
 *   3. question_text porté par la ligne audio elle-même   → 'own_question_text' (non prouvé → plafonne B)
 */

const Database = require('better-sqlite3');
const path = require('path');

// Même logique d'URL audio que server_routes_v2 : B2 > CDN > local, toujours .mp3
function getAudioUrl(audioPath) {
    if (!audioPath) return null;
    const mp3Name = path.basename(audioPath).replace(/\.(ogg|opus)$/i, '.mp3');
    if (process.env.B2_BUCKET_NAME) return `/audio-b2/${mp3Name}`;
    const baseUrl = process.env.MEDIA_BASE_URL;
    if (baseUrl) return `${baseUrl.replace(/\/$/, '')}/${mp3Name}`;
    return `/audio/${mp3Name}`;
}

/**
 * @param {string} dbPath - chemin de ravqa.db
 * @param {Array<{id:number, score:number}>} ranked - résultats de recherche triés
 * @returns {Array} candidats au format psak_engine
 */
function hydraterCandidats(dbPath, ranked) {
    if (!ranked || ranked.length === 0) return [];
    const db = new Database(dbPath, { readonly: true });
    try {
        const ids = ranked.map(r => r.id);
        const placeholders = ids.map(() => '?').join(',');
        const rows = db.prepare(`
            SELECT a.id, a.ts, a.audio_path,
                   COALESCE(NULLIF(a.transcript_torah,''), a.transcript_raw) AS answer,
                   CASE WHEN a.question_text != 'audio omis' THEN a.question_text END AS own_q,
                   a.link_confidence, a.link_method,
                   qr.question_text  AS reply_q,
                   COALESCE(ql1.question_text, ql2.question_text) AS link_q
            FROM messages a
            LEFT JOIN messages qr  ON qr.wa_message_id = a.replied_to_message_id
                                   AND qr.question_text IS NOT NULL AND trim(qr.question_text) != ''
            LEFT JOIN messages ql1 ON ql1.id = a.link_question_id
                                   AND ql1.question_text IS NOT NULL AND trim(ql1.question_text) != ''
            LEFT JOIN messages ql2 ON ql2.wa_message_id = a.link_question_id
                                   AND ql2.question_text IS NOT NULL AND trim(ql2.question_text) != ''
            WHERE a.id IN (${placeholders}) AND a.deleted_at IS NULL
        `).all(...ids);

        const parId = new Map(rows.map(r => [r.id, r]));

        return ranked.map(({ id, score }) => {
            const r = parId.get(id);
            if (!r) return null;

            let question, linkMethod, linkConfidence;
            if (r.reply_q) {
                question = r.reply_q; linkMethod = 'reply'; linkConfidence = 1.0;
            } else if (r.link_q) {
                question = r.link_q;
                linkMethod = r.link_method || 'link';
                linkConfidence = r.link_confidence;
            } else if (r.own_q && r.own_q.trim()) {
                // question portée par la ligne mais jamais prouvée → le moteur plafonnera à B
                question = r.own_q; linkMethod = 'own_question_text'; linkConfidence = null;
            } else {
                question = null; linkMethod = null; linkConfidence = null;
            }

            return {
                id,
                score,
                question,
                answer: r.answer,
                audioUrl: getAudioUrl(r.audio_path),
                linkMethod,
                linkConfidence,
                timestamp: r.ts,
            };
        }).filter(Boolean);
    } finally {
        db.close();
    }
}

module.exports = { hydraterCandidats, getAudioUrl };
