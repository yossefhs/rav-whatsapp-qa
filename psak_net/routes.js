/**
 * Endpoints Psak Net — implémentation de référence branchée sur ce dépôt.
 *
 *   POST /api/psak          { question } → verdict A/B/C/D + message formaté + source
 *   GET  /api/psak/health   état des dépendances (embeddings, juge, vecteurs)
 *
 * Sécurité par défaut :
 *   - recherche sémantique indisponible → Verdict D (abstention explicite, jamais
 *     de fallback silencieux) ;
 *   - juge LLM indisponible (pas de clé Anthropic) → jamais de Verdict A : tout
 *     match plafonne à B « à vérifier ». Un psak « confirmé » exige le juge.
 */

require('dotenv').config();
const { deciderVerdict, formaterReponse, VERDICT } = require('./psak_engine');
const { hydraterCandidats } = require('./candidats');

const DB_PATH = process.env.DB_PATH || './ravqa.db';

// Juge de repli quand ANTHROPIC_API_KEY est absent : ne confirme JAMAIS un match
// exact — il déclasse tout en PROCHE pour que le moteur ne sorte au mieux qu'un B.
async function jugePrudent() {
    return { verdict: 'MATCH_PROCHE', raison: 'Juge LLM indisponible — confirmation impossible, correspondance à vérifier' };
}

function setupPsakEndpoints(app) {
    const express = require('express');

    app.post('/api/psak', express.json(), async (req, res) => {
        const question = (req.body.question || req.body.query || '').trim();
        if (question.length < 3) {
            return res.status(400).json({ success: false, error: 'Question requise (minimum 3 caractères)' });
        }

        try {
            // 1) Recherche sémantique (échec ou vide anormal → santé dégradée)
            let ranked = [];
            let searchHealthy = true;
            if (!process.env.OPENAI_API_KEY) {
                searchHealthy = false;
            } else {
                try {
                    const { searchLocal } = require('../rag_api');
                    ranked = await searchLocal(question, 10);
                    if (!Array.isArray(ranked)) searchHealthy = false;
                } catch (e) {
                    console.error('❌ Psak: recherche indisponible:', e.message);
                    searchHealthy = false;
                }
            }

            // 2) Hydratation depuis la base (question d'origine + audio + fiabilité du lien)
            const candidats = searchHealthy
                ? hydraterCandidats(DB_PATH, ranked.map(r => ({ id: r.id, score: r.score })))
                : [];

            // 3) Verdict
            const opts = { searchHealthy };
            if (!process.env.ANTHROPIC_API_KEY) opts.judge = jugePrudent;
            const resultat = await deciderVerdict(question, candidats, opts);

            res.json({
                success: true,
                verdict: resultat.verdict,
                message: formaterReponse(resultat),
                source: resultat.source ? {
                    id: resultat.source.id,
                    question: resultat.source.question,
                    answer: resultat.source.answer,
                    audio_url: resultat.source.audioUrl,
                    link_method: resultat.source.linkMethod,
                    link_confidence: resultat.source.linkConfidence,
                    score: resultat.source.score,
                } : null,
                judge: resultat.judge || null,
                raison: resultat.raison,
            });
        } catch (error) {
            console.error('❌ Psak endpoint error:', error);
            // En cas d'erreur interne, on s'abstient — même règle que le Verdict D
            res.status(500).json({
                success: false,
                verdict: VERDICT.SYSTEME_DEGRADE,
                message: formaterReponse({ verdict: VERDICT.SYSTEME_DEGRADE }),
                error: error.message,
            });
        }
    });

    app.get('/api/psak/health', (req, res) => {
        let vectors = 0;
        try {
            const Database = require('better-sqlite3');
            const db = new Database(DB_PATH, { readonly: true });
            vectors = db.prepare('SELECT COUNT(*) AS c FROM message_embeddings').get().c;
            db.close();
        } catch (e) { /* table absente → 0 */ }
        res.json({
            embeddings_openai: Boolean(process.env.OPENAI_API_KEY),
            judge_anthropic: Boolean(process.env.ANTHROPIC_API_KEY),
            vectors_indexed: vectors,
            verdict_A_possible: Boolean(process.env.OPENAI_API_KEY && process.env.ANTHROPIC_API_KEY && vectors > 0),
        });
    });

    console.log('⚖️ Psak Net endpoints registered: POST /api/psak, GET /api/psak/health');
}

module.exports = { setupPsakEndpoints };
