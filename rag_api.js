/**
 * RAG Search API avec Garde-fous
 * Endpoint sécurisé pour recherche vectorielle
 */

require('dotenv').config();
const { applyGuardrails, calculateConfidence, filterQuery } = require('./guardrails');
const OpenAI = require('openai');
const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.DB_PATH || './ravqa.db';
const QDRANT_URL = process.env.QDRANT_URL || 'http://localhost:6333';
const COLLECTION = 'halakhic_qa';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
// Database is instantiated per request or cached? Better to instantiate once here if serverless isn't an issue.
// For this continuous server architecture, one instance is fine.
// Cache des vecteurs en mémoire
let vectorsCache = null;
let lastCacheUpdate = 0;

function loadVectors() {
    // Recharger seulement si +5min ou premier appel
    if (vectorsCache && (Date.now() - lastCacheUpdate < 5 * 60 * 1000)) {
        return vectorsCache;
    }

    console.log('🔄 Chargement des vecteurs en mémoire...');
    const db = new Database(DB_PATH, { readonly: true });
    try {
        // Jointure pour avoir les métadonnées utiles
        const rows = db.prepare(`
            SELECT e.id, e.vector, 
                   m.question_text, m.transcript_torah, m.transcript_raw, m.audio_path,
                   m.ts, m.group_name, m.relevance_score
            FROM message_embeddings e
            JOIN messages m ON e.id = m.id
            WHERE m.deleted_at IS NULL
        `).all();

        vectorsCache = rows.map(r => ({
            id: r.id,
            vector: JSON.parse(r.vector),
            payload: {
                question: r.question_text,
                answer: r.transcript_torah || r.transcript_raw,
                audio_path: r.audio_path,
                timestamp: r.ts,
                group_name: r.group_name
            },
            relevance_score: r.relevance_score || 0.5
        }));

        lastCacheUpdate = Date.now();
        console.log(`✅ ${vectorsCache.length} vecteurs chargés en RAM.`);
    } catch (e) {
        console.error('Erreur chargement vecteurs:', e);
        vectorsCache = [];
    } finally {
        db.close();
    }
    return vectorsCache;
}

// Similarité Cosinus
function cosineSimilarity(a, b) {
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// Embedding
async function getEmbedding(text) {
    const response = await openai.embeddings.create({
        model: 'text-embedding-3-small',
        input: text.substring(0, 8000)
    });
    return response.data[0].embedding;
}

// Recherche Locale (Hybride & Apprentissage)
async function searchLocal(query, limit = 10) {
    try {
        const queryVector = await getEmbedding(query);
        const vectors = loadVectors();

        // Mots-clés pour recherche hybride simple
        const keywords = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);

        // Calcul score pour tous
        const results = vectors.map(v => {
            const cosSim = cosineSimilarity(queryVector, v.vector);

            // 1. Boost Apprentissage (Relevance Score)
            // Base score 0.5 -> multiplicateur 1.0
            // Score 1.0 (très validé) -> multiplicateur 1.2 (+20%)
            const relevanceBoost = 1.0 + ((v.relevance_score || 0.5) - 0.5) * 0.4;

            // 2. Boost Hybride (Mots-clés exacts)
            // Si la question contient un mot clé rare, petit boost
            let keywordBonus = 0;
            const qLower = (v.payload.question || '').toLowerCase();
            keywords.forEach(k => {
                if (qLower.includes(k)) keywordBonus += 0.05;
            });

            return {
                ...v,
                score: (cosSim * relevanceBoost) + keywordBonus
            };
        });

        // Trier et limiter
        return results
            .sort((a, b) => b.score - a.score)
            .slice(0, limit)
            .map(r => ({
                id: r.id,
                score: r.score,
                feedback_score: r.relevance_score,
                question: r.payload.question || '',
                answer: r.payload.answer || '',
                audio_path: r.payload.audio_path,
                group_name: r.payload.group_name || '',
                timestamp: r.payload.timestamp
            }));

    } catch (error) {
        console.error('Local search error:', error);
        return [];
    }
}

/**
 * Recherche RAG sécurisée avec garde-fous
 */
async function secureRAGSearch(query, options = {}) {
    const startTime = Date.now();
    const limit = options.limit || 5;
    const includeDetails = options.includeDetails !== false;

    // 1. Validation entrée
    const queryValidation = filterQuery(query);
    if (!queryValidation.valid) {
        return {
            success: false,
            error: queryValidation.reason,
            results: [],
            stats: { duration: Date.now() - startTime }
        };
    }

    // 2. Recherche Locale
    const rawResults = await searchLocal(queryValidation.cleaned, limit * 2);

    // 3. Application garde-fous
    const guardedResult = await applyGuardrails(query, rawResults);

    // 4. Construire réponse
    return {
        success: guardedResult.success,
        query: {
            original: query,
            cleaned: queryValidation.cleaned,
            isHalakhic: queryValidation.isHalakhic
        },
        results: guardedResult.results.slice(0, limit).map(r => ({
            id: r.id,
            question: r.question,
            answer: includeDetails ? r.answer : r.answer.substring(0, 200) + '...',
            confidence: r.confidence,
            audio_url: r.audio_path ? `/audio/${path.basename(r.audio_path)}` : null
        })),
        stats: {
            duration: Date.now() - startTime,
            total_found: rawResults.length,
            validated: guardedResult.stats?.validated || 0,
            rejected: guardedResult.stats?.rejected || 0
        }
    };
}

function setupRAGEndpoints(app) {
    const express = require('express');

    // POST /api/rag-search
    app.post('/api/rag-search', express.json(), async (req, res) => {
        try {
            const { query, limit } = req.body;
            if (!query) return res.status(400).json({ error: 'Query requis' });

            const result = await secureRAGSearch(query, { limit: limit || 5 });
            res.json(result);
        } catch (error) {
            console.error(error);
            res.status(500).json({ error: error.message });
        }
    });

    // GET /api/rag-search
    app.get('/api/rag-search', async (req, res) => {
        try {
            const query = req.query.q || req.query.query;
            if (!query) return res.status(400).json({ error: 'Query requis' });

            const result = await secureRAGSearch(query, { limit: parseInt(req.query.limit) || 5 });
            res.json(result);
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    // GET /api/rag-stats
    app.get('/api/rag-stats', (req, res) => {
        const vectors = loadVectors();
        res.json({
            mode: 'local_sqlite',
            points_count: vectors.length
        });
    });

    console.log('✅ RAG endpoints registered (Mode: Local SQLite)');
}

// ... (existing code)

function invalidateCache() {
    vectorsCache = null;
    lastCacheUpdate = 0;
    console.log('🔄 Cache vectoriel invalidé (Edit/Delete détecté)');
}

module.exports = {
    secureRAGSearch,
    searchLocal,
    getEmbedding,
    setupRAGEndpoints,
    invalidateCache // Exported
};
