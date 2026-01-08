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
const db = new Database(DB_PATH, { readonly: true });

/**
 * Obtenir embedding via OpenAI
 */
async function getEmbedding(text) {
    const response = await openai.embeddings.create({
        model: 'text-embedding-3-small',
        input: text.substring(0, 8000)
    });
    return response.data[0].embedding;
}

/**
 * Recherche vectorielle dans Qdrant
 */
async function searchQdrant(query, limit = 10) {
    try {
        const queryVector = await getEmbedding(query);

        const response = await fetch(`${QDRANT_URL}/collections/${COLLECTION}/points/search`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                vector: queryVector,
                limit: limit,
                with_payload: true
            })
        });

        const data = await response.json();

        if (!data.result) {
            console.error('Qdrant error:', data);
            return [];
        }

        // Transformer et hydrater avec les scores de feedback live
        return data.result.map(r => {
            // Récupérer le score de pertinence live depuis SQLite
            let feedbackScore = 0.5; // Défaut
            try {
                const row = db.prepare('SELECT relevance_score FROM messages WHERE wa_message_id = ?').get(r.id);
                if (row && row.relevance_score !== null) {
                    feedbackScore = row.relevance_score;
                }
            } catch (e) {
                // Ignore DB errors during hydrating
            }

            return {
                id: r.id,
                score: r.score, // Vector score
                feedback_score: feedbackScore, // <-- NOUVEAU: Score d'apprentissage
                question: r.payload?.question || '',
                answer: r.payload?.answer || '',
                audio_path: r.payload?.audio_path,
                group_name: r.payload?.group_name || '',
                timestamp: r.payload?.timestamp
            };
        });
    } catch (error) {
        console.error('Qdrant search error:', error);
        return [];
    }
}

/**
 * Recherche RAG sécurisée avec garde-fous
 */
async function secureRAGSearch(query, options = {}) {
    const startTime = Date.now();

    // Options par défaut
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

    // 2. Recherche Qdrant
    const rawResults = await searchQdrant(queryValidation.cleaned, limit * 2);

    // 3. Application garde-fous
    const guardedResult = await applyGuardrails(query, rawResults);

    // 4. Construire réponse
    const response = {
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
            audio_url: r.audio_path ? `/audio/${require('path').basename(r.audio_path)}` : null
        })),
        stats: {
            duration: Date.now() - startTime,
            total_found: rawResults.length,
            validated: guardedResult.stats?.validated || 0,
            rejected: guardedResult.stats?.rejected || 0
        }
    };

    // Ajouter warning si présent
    if (guardedResult.warning) {
        response.warning = guardedResult.warning;
    }

    // Ajouter message si pas de résultats
    if (!guardedResult.success && guardedResult.message) {
        response.message = guardedResult.message;
    }

    return response;
}

/**
 * Middleware Express pour l'API
 */
function setupRAGEndpoints(app) {
    const express = require('express');

    // POST /api/rag-search - Recherche sécurisée
    app.post('/api/rag-search', express.json(), async (req, res) => {
        const { query, limit } = req.body;

        if (!query) {
            return res.status(400).json({
                success: false,
                error: 'Le paramètre "query" est requis'
            });
        }

        try {
            const result = await secureRAGSearch(query, { limit: limit || 5 });
            res.json(result);
        } catch (error) {
            console.error('RAG Search error:', error);
            res.status(500).json({
                success: false,
                error: 'Erreur serveur',
                message: error.message
            });
        }
    });

    // GET /api/rag-search?q=... - Version GET pour tests rapides
    app.get('/api/rag-search', async (req, res) => {
        const query = req.query.q || req.query.query;
        const limit = parseInt(req.query.limit) || 5;

        if (!query) {
            return res.status(400).json({
                success: false,
                error: 'Le paramètre "q" est requis'
            });
        }

        try {
            const result = await secureRAGSearch(query, { limit });
            res.json(result);
        } catch (error) {
            console.error('RAG Search error:', error);
            res.status(500).json({
                success: false,
                error: 'Erreur serveur'
            });
        }
    });

    // GET /api/rag-stats - Statistiques du système
    app.get('/api/rag-stats', async (req, res) => {
        try {
            const qdrantInfo = await fetch(`${QDRANT_URL}/collections/${COLLECTION}`);
            const info = await qdrantInfo.json();

            res.json({
                collection: COLLECTION,
                points_count: info.result?.points_count || 0,
                status: info.result?.status || 'unknown',
                guardrails: {
                    version: '1.0',
                    features: ['query_filter', 'response_filter', 'confidence_scoring', 'rejection']
                }
            });
        } catch (error) {
            res.status(500).json({ error: 'Impossible de récupérer les stats' });
        }
    });

    console.log('✅ RAG endpoints registered: /api/rag-search, /api/rag-stats');
}

module.exports = {
    secureRAGSearch,
    searchQdrant,
    getEmbedding,
    setupRAGEndpoints
};
