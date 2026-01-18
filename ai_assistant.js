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

/**
 * Générer une réponse avec GPT basée sur les sources
 */
async function generateAnswer(question, sources) {
    if (!sources || sources.length === 0) {
        return {
            answer: "Je n'ai pas trouvé de sources pertinentes pour répondre à cette question.",
            sourcesUsed: []
        };
    }

    // Construire le contexte des sources avec date
    const sourcesContext = sources.map(s =>
        `[Source ${s.index}] (${s.date || 'Date inconnue'})\nQuestion: ${s.question}\nRéponse du Rav: ${s.answer}\n`
    ).join('\n---\n');

    const systemPrompt = `Tu es un assistant expert en Halakha (Loi Juive) basé UNIQUEMENT sur les enseignements du Rav Abichid.

DIRECTIVE PRIMAIRE: "NO HALLUCINATION"
Tu ne dois répondre qu'en utilisant EXCLUSIVEMENT les extraits de texte fournis ci-dessous ("SOURCES").
- Si la réponse n'est pas dans les sources : dis "Je ne trouve pas l'information dans les archives."
- Si les sources sont contradictoires : mentionne-le.
- Cite tes sources avec [Source X].

RÈGLES STRICTES:
1. Ne JAMAIS inventer de halakha ou ajouter d'informations externes.
2. Utilise un ton respectueux, direct et précis.
3. Réponds en français soigné.

SOURCES DISPONIBLES:
${sourcesContext}`;

    const userPrompt = `Question de l'utilisateur: ${question}

Génère une réponse synthétique en citant les numéros des sources [1], [2], etc. que tu utilises.
La réponse doit être claire, concise et basée uniquement sur les sources fournies.`;

    try {
        const completion = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt }
            ],
            temperature: 0.3,
            max_tokens: 800
        });

        const answer = completion.choices[0].message.content;

        // Extraire les sources citées (ex: [1], [2], [3])
        const citedNumbers = [...answer.matchAll(/\[(\d+)\]/g)].map(m => parseInt(m[1]));
        const uniqueCited = [...new Set(citedNumbers)];
        const sourcesUsed = sources.filter(s => uniqueCited.includes(s.index));

        return {
            answer,
            sourcesUsed: sourcesUsed.length > 0 ? sourcesUsed : sources.slice(0, 3)
        };
    } catch (error) {
        console.error('GPT generation error:', error);
        return {
            answer: "Une erreur s'est produite lors de la génération de la réponse.",
            sourcesUsed: sources.slice(0, 3)
        };
    }
}

/**
 * Analyse et reformule la question pour optimiser la recherche vectorielle
 * (Query Expansion / HyDE Lite)
 */
async function analyzeAndRefineQuery(question) {
    if (!openai) return question;

    try {
        const completion = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [
                {
                    role: 'system',
                    content: `Tu es un expert en recherche sémantique de Halakha.
Ta mission : Reformuler la question de l'utilisateur pour maximiser la pertinence de la recherche dans une base de données de questions-réponses.
1. Corrige les fautes d'orthographe.
2. Explicite les termes implicites (ex: "lait viande" -> "mélange lait et viande basar behalav").
3. Ajoute 2-3 mots-clés techniques hébreux pertinents si applicables (ex: Muktze, Borrer, Se'hita).
4. La phrase doit être une question complète et bien formulée.

Retourne UNIQUEMENT la nouvelle question reformulée, sans guillemets ni intro.`
                },
                { role: 'user', content: question }
            ],
            temperature: 0.3,
            max_tokens: 100
        });

        const refinedQuery = completion.choices[0].message.content.trim();
        console.log(`🔍 Query Refined: "${question}" -> "${refinedQuery}"`);
        return refinedQuery;
    } catch (error) {
        console.error('Query refinement error:', error);
        return question; // Fallback to original
    }
}

/**
 * Fonction principale: Poser une question à l'assistant
 */
async function askAssistant(question, options = {}) {

    const startTime = Date.now();
    // FORCE LIMIT TO 3 to ensure synchronization with UI
    const limit = 3;

    // 0. (NOUVEAU) Refiner la question avec GPT pour mieux chercher
    const refinedQuery = await analyzeAndRefineQuery(question);

    // 1. Rechercher les Q&A similaires en utilisant la question optimisée
    const sources = await searchSimilarQA(refinedQuery, limit);

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
