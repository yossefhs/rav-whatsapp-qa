/**
 * RAG Search API avec Garde-fous
 * Endpoint sécurisé pour recherche vectorielle
 */

require('dotenv').config();
const { applyGuardrails, calculateConfidence, filterQuery } = require('./guardrails');
const OpenAI = require('openai');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || './ravqa.db';
const QDRANT_URL = process.env.QDRANT_URL || 'http://localhost:6333';
const COLLECTION = 'halakhic_qa';

let openai = null;
try {
    if (process.env.OPENAI_API_KEY) {
        openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    } else {
        console.warn('⚠️ OPENAI_API_KEY non défini - RAG désactivé');
    }
} catch (e) {
    console.error('❌ OpenAI init error:', e.message);
}

// Cache des vecteurs en mémoire
// Cache des vecteurs en mémoire (Optimisé: ID + Vector + Metadata légères uniquement)
let vectorsCache = null;
let lastCacheUpdate = 0;

function loadVectors() {
    // Recharger seulement si +5min ou premier appel
    if (vectorsCache && (Date.now() - lastCacheUpdate < 5 * 60 * 1000)) {
        return vectorsCache;
    }

    console.log('🔄 Chargement des vecteurs en mémoire (Mode Léger)...');
    const db = new Database(DB_PATH, { readonly: true });
    try {
        // ON NE CHARGE PAS LE TEXTE (Question/Reponse) ICI pour économiser la RAM
        // On charge uniquement ce qui est nécessaire au calcul de similarité/score
        const rows = db.prepare(`
            SELECT e.id, e.vector, 
                   m.relevance_score,
                   COALESCE(SUM(CASE WHEN f.is_relevant = 1 THEN 1 WHEN f.is_relevant = 0 THEN -1 ELSE 0 END), 0) as feedback_score
            FROM message_embeddings e
            JOIN messages m ON e.id = m.id
            LEFT JOIN feedback f ON m.id = f.message_id
            WHERE m.deleted_at IS NULL
            GROUP BY m.id
        `).all();

        vectorsCache = rows.map(r => ({
            id: r.id,
            vector: JSON.parse(r.vector),
            feedback_score: r.feedback_score,
            relevance_score: r.relevance_score || 0.5
        }));

        lastCacheUpdate = Date.now();
        console.log(`✅ ${vectorsCache.length} vecteurs chargés en RAM (Optimisé).`);
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

// Recherche Locale (Hybride: Vector RAM + Content DB)
async function searchLocal(query, limit = 10) {
    let db = null;
    try {
        const queryVector = await getEmbedding(query);
        const vectors = loadVectors();

        // 1. Calcul des scores en RAM (Rapide & Léger)
        const ranked = vectors.map(v => {
            const cosine = cosineSimilarity(queryVector, v.vector);
            // Boost: +5% par vote positif
            const boost = Math.min(Math.max((v.feedback_score || 0) * 0.05, -0.2), 0.2);
            return {
                id: v.id,
                score: cosine * (1 + boost),
                raw_score: cosine,
                feedback_score: v.feedback_score // Pass it through for debugging if needed
            };
        })
            .sort((a, b) => b.score - a.score)
            .slice(0, limit);

        if (ranked.length === 0) return [];

        // 2. Hydratation : Récupérer le contenu complet depuis la DB pour les Top K seulement
        db = new Database(DB_PATH, { readonly: true });
        const ids = ranked.map(r => r.id);
        const placeholders = ids.map(() => '?').join(',');

        const details = db.prepare(`
            SELECT id, question_text, transcript_torah, transcript_raw, audio_path, ts, group_name
            FROM messages
            WHERE id IN (${placeholders})
        `).all(...ids);

        // 3. Fusionner Score + Contenu
        // Map pour lookup rapide
        const contentMap = new Map(details.map(d => [d.id, d]));

        return ranked.map(r => {
            const content = contentMap.get(r.id);
            if (!content) return null; // Should not happen
            return {
                id: r.id,
                score: r.score,
                feedback_score: r.feedback_score, // properly passed
                question: content.question_text || '',
                answer: content.transcript_torah || content.transcript_raw || '',
                audio_path: content.audio_path,
                group_name: content.group_name || '',
                timestamp: content.ts
            };
        }).filter(Boolean);

    } catch (error) {
        console.error('Local search error:', error);
        return [];
    } finally {
        if (db) db.close();
    }
}

// Helper to get correct Audio URL (MP3 preferred)
function getAudioUrl(audioPath) {
    if (!audioPath) return null;
    const basename = path.basename(audioPath);
    const mediaDir = path.join(__dirname, 'media');

    // 1. Check exact match
    if (fs.existsSync(path.join(mediaDir, basename))) {
        return `/audio/${basename}`;
    }

    // 2. Check MP3 version
    const mp3Name = basename.replace(/\.(ogg|opus)$/i, '.mp3');
    if (fs.existsSync(path.join(mediaDir, mp3Name))) {
        return `/audio/${mp3Name}`;
    }

    // 3. Fallback
    return `/audio/${basename}`;
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
    const rawResults = await searchLocal(queryValidation.cleaned, limit * 3);

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
            audio_url: getAudioUrl(r.audio_path)
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
    invalidateCache
};
