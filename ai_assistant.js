/**
 * AI Assistant - Génération de réponses halakhiques avec sources
 * Utilise RAG (Qdrant) + GPT pour synthétiser des réponses
 */

require('dotenv').config();
const OpenAI = require('openai');

const QDRANT_URL = process.env.QDRANT_URL || 'http://localhost:6333';
const COLLECTION = 'halakhic_qa';

let openai = null;
try {
    if (process.env.OPENAI_API_KEY) {
        openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    } else {
        console.warn('⚠️ OPENAI_API_KEY non défini - AI Assistant désactivé');
    }
} catch (e) {
    console.error('❌ OpenAI init error:', e.message);
}

// Helper to get correct Audio URL (MP3 preferred)
const fs = require('fs');
const path = require('path');
function getAudioUrl(audioPath) {
    if (!audioPath) return null;
    const basename = path.basename(audioPath);
    const mediaDir = path.join(__dirname, 'media'); // Assumes this file is in root

    // 1. Check exact match
    if (fs.existsSync(path.join(mediaDir, basename))) {
        return `/audio/${basename}`;
    }

    // 2. Check MP3 version
    const mp3Name = basename.replace(/\.(ogg|opus)$/i, '.mp3');
    if (fs.existsSync(path.join(mediaDir, mp3Name))) {
        return `/audio/${mp3Name}`;
    }

    return `/audio/${basename}`;
}

const { searchLocal } = require('./rag_api');

/**
 * Recherche vectorielle locale
 */
async function searchSimilarQA(query, limit = 3) { // Default reduced to 3
    try {
        // Request more results initially for deduplication
        const results = await searchLocal(query, limit * 2);

        // Deduplicate based on similar content
        const seen = new Set();
        const uniqueResults = results.filter(r => {
            // Create a content signature (first 100 chars of answer)
            const signature = (r.answer || '').substring(0, 100).toLowerCase().replace(/\s+/g, ' ');
            if (seen.has(signature)) return false;
            seen.add(signature);
            return true;
        });

        // Slice to limit (default 3)
        return uniqueResults.slice(0, limit).map((r, index) => ({
            index: index + 1,
            id: r.id,
            score: r.score,
            question: r.question || '',
            answer: r.answer || '',
            audio_path: r.audio_path,
            hasAudio: !!r.audio_path,
            timestamp: r.timestamp, // Add date
            date: r.timestamp ? new Date(r.timestamp * 1000).toLocaleDateString('fr-FR') : null
        }));
    } catch (error) {
        console.error('Local search error:', error);
        return [];
    }
}

// ... (generateAnswer remains similar, but using limit=3)

/**
 * Fonction principale: Poser une question à l'assistant
 */
async function askAssistant(question, options = {}) {
    const startTime = Date.now();
    // FORCE LIMIT TO 3 to ensure synchronization with UI
    const limit = 3;

    // 1. Rechercher les Q&A similaires
    const sources = await searchSimilarQA(question, limit);

    if (sources.length === 0) {
        return {
            success: false,
            question,
            answer: "Je n'ai pas trouvé de réponses similaires dans la base de données du Rav Abichid.",
            disclaimer: "⚠️ Veuillez poser votre question directement au Rav Abichid.",
            sources: [],
            confidence: 0,
            stats: { duration: Date.now() - startTime, sources_found: 0 }
        };
    }

    // 2. Générer une réponse avec GPT
    const { answer, sourcesUsed } = await generateAnswer(question, sources);

    // 3. Calculer la confiance moyenne
    const avgScore = sourcesUsed.length > 0
        ? sourcesUsed.reduce((sum, s) => sum + s.score, 0) / sourcesUsed.length
        : 0;

    return {
        success: true,
        question,
        answer,
        disclaimer: "⚠️ Cette réponse est générée par IA sous réserve. Veuillez vérifier avec le Rav Abichid pour confirmation.",
        sources: sourcesUsed.map(s => ({
            id: s.id,
            index: s.index,
            question: s.question,
            answer: s.answer, // Full transcription
            date: s.date, // Date of the message
            similarity: Math.round(s.score * 100),
            hasAudio: s.hasAudio,
            audioUrl: getAudioUrl(s.audio_path) // Use helper!
        })),
        confidence: Math.round(avgScore * 100),
        stats: {
            duration: Date.now() - startTime,
            sources_found: sources.length,
            sources_used: sourcesUsed.length
        }
    };
}

/**
 * Setup Express endpoints
 */
function setupAIAssistantEndpoints(app) {
    const express = require('express');

    // POST /api/ask - Poser une question à l'assistant
    app.post('/api/ask', express.json(), async (req, res) => {
        const { question, limit } = req.body;

        if (!question || question.trim().length < 5) {
            return res.status(400).json({
                success: false,
                error: 'La question doit contenir au moins 5 caractères'
            });
        }

        try {
            console.log(`🤖 Question: "${question.substring(0, 50)}..."`);
            const result = await askAssistant(question, { limit: limit || 5 });
            console.log(`✅ Réponse générée en ${result.stats.duration}ms (${result.stats.sources_used} sources)`);
            res.json(result);
        } catch (error) {
            console.error('AI Assistant error:', error);
            res.status(500).json({
                success: false,
                error: 'Erreur lors de la génération de la réponse',
                message: error.message
            });
        }
    });

    // GET /api/ask?q=... - Version GET pour tests rapides
    app.get('/api/ask', async (req, res) => {
        const question = req.query.q || req.query.question;
        const limit = parseInt(req.query.limit) || 5;

        if (!question || question.trim().length < 5) {
            return res.status(400).json({
                success: false,
                error: 'Le paramètre "q" est requis (min 5 caractères)'
            });
        }

        try {
            const result = await askAssistant(question, { limit });
            res.json(result);
        } catch (error) {
            res.status(500).json({
                success: false,
                error: 'Erreur serveur'
            });
        }
    });

    console.log('🤖 AI Assistant endpoints registered: /api/ask');
}

module.exports = {
    askAssistant,
    searchSimilarQA,
    generateAnswer,
    setupAIAssistantEndpoints
};
