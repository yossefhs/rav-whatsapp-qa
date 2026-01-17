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
                   m.ts, m.group_name, m.relevance_score,
                   -- Calcul du score de pertinence basé sur les votes (Net Promoter Score simplifié)
                   COALESCE(SUM(CASE WHEN f.is_valid = 1 THEN 1 WHEN f.is_valid = 0 THEN -1 ELSE 0 END), 0) as feedback_score
            FROM message_embeddings e
            JOIN messages m ON e.id = m.id
            LEFT JOIN feedback f ON m.id = f.message_id
            WHERE m.deleted_at IS NULL
            GROUP BY m.id
        `).all();

        vectorsCache = rows.map(r => ({
            id: r.id,
            vector: JSON.parse(r.vector),
            payload: {
                question: r.question_text,
                answer: r.transcript_torah || r.transcript_raw,
                audio_path: r.audio_path,
                timestamp: r.ts,
                group_name: r.group_name,
                feedback_score: r.feedback_score // Store score for reranking
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

// Recherche Locale
async function searchLocal(query, limit = 10) {
    try {
        const queryVector = await getEmbedding(query);
        const vectors = loadVectors();

        // Calcul score pour tous avec Boost Feedback
        const results = vectors.map(v => {
            const cosine = cosineSimilarity(queryVector, v.vector);

            // Boost: +5% par vote positif (net), borné à +/- 20%
            const boost = Math.min(Math.max((v.payload.feedback_score || 0) * 0.05, -0.2), 0.2);

            return {
                ...v,
                raw_score: cosine,
                score: cosine * (1 + boost)
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

// Helper to get correct Audio URL (MP3 preferred)
const fs = require('fs'); // Ensure fs is required
function getAudioUrl(audioPath) {
    if (!audioPath) return null;
    const basename = path.basename(audioPath);
    const mediaDir = path.join(__dirname, 'media'); // Assumes rag_api.js is in root alongside media/

    // 1. Check exact match (or OGG if that's what's asked)
    if (fs.existsSync(path.join(mediaDir, basename))) {
        return `/audio/${basename}`;
    }

    // 2. Check MP3 version
    const mp3Name = basename.replace(/\.(ogg|opus)$/i, '.mp3');
    if (fs.existsSync(path.join(mediaDir, mp3Name))) {
        return `/audio/${mp3Name}`;
    }

    // 3. Fallback: Lookup by ID in loose file matching (Optional but good)
    // For now, MP3 switch is the main fix for mobile.
    return `/audio/${basename}`;
}

/**
 * Recherche RAG sécurisée avec garde-fous
 */
async function secureRAGSearch(query, options = {}) {
    // ... (rest of the logic remains same, but we will inject a better prompt in a hypothetical 'generateAnswer' function or similar? 
    // Wait, secureRAGSearch calls searchLocal and applyGuardrails. 
    // The current file doesn't seem to have the 'answer generation' part (OpenAI ChatCompletion).
    // Ah, 'searchLocal' returns results, and 'secureRAGSearch' returns them.
    // The user's request is "precision des reponse".
    // If this API *only* returns search results (not a generated summary), then "precision" means "better ranking".

    // Let's look at `searchLocal` again. It uses cosine similarity.
    // Without Qdrant, we depend on `loadVectors`.

    // To improve precision WITHOUT Qdrant (since Docker is down):
    // 1. We can filter results more aggressively in `searchLocal`.
    // 2. We can re-rank based on keyword overlap (Hybrid Search simulation).

    // We already added 'Thematic Score' in `guardrails.js`.

    // Actually, `rag_api.js` does NOT generate an answer. It returns `guardedResult`.
    // The Client (Frontend) likely uses these chunks to generate an answer, OR there is another endpoint for generation.
    // Let's check `rag_api.js` lines 192+. It returns `res.json(result)`.

    // I need to find where the AI *generates* the answer text if the user implies "precision des mots de la réponse".
    // OR if they mean "precision des résultats trouvés".

    // Assuming "precision des résultats":
    // I will boost the 'Thematic' weight in `guardrails.js` (WEIGHTS).

    return await originalSecureRAGLogic(query, options);
}

// Re-implementing secureRAGSearch to be sure I don't break it, but actually I should edit `guardrails.js` to change weights.
// The user also asked for "liaison des questions réponses".
// The `link_orphans.js` script handles the data layer.
// To expose this better, I should ensure `searchLocal` returns the LINKED question if available.
// In `loadVectors`, we Select `m.question_text`. If `link_orphans` runs, this field will be populated!
// So just running `link_orphans` improves the RAG data source immediately.

// I will Focus on `guardrails.js` to tune the weights for better precision.
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

// 2. Recherche Locale (Updated logic to be smarter?)
// We can boost keywords here before cosine check?
// Actually `searchLocal` does the heavy lifting.
const rawResults = await searchLocal(queryValidation.cleaned, limit * 3); // Get more candidates for re-ranking

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
