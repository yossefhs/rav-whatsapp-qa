/**
 * Server Routes V2 - Streaming SSE Endpoints (Mission 3)
 * 
 * Expose l'API V2 avec support Server-Sent Events pour
 * une expérience utilisateur fluide (réponses en temps réel)
 * 
 * @author RavQA V2
 */

require('dotenv').config();
const OpenAI = require('openai');
const { classifyIntent } = require('./ai_router');
const { classifyIntent: classifyIntentRules, INTENT } = require('./intent_router_v2');
const { QdrantClient } = require('./qdrant_client_v2');
const { getEmbedding, searchLocal } = require('./rag_api'); // Import searchLocal for fallback
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const DB_PATH = process.env.DB_PATH || 'ravqa.db';

// Helper: Get audio URL preferring MP3 over OGG
function getAudioUrl(audioPath) {
    if (!audioPath) return null;
    const basename = path.basename(audioPath); // Strip /Users/admin/...
    const mediaDir = path.join(__dirname, 'media'); // Assume media is in same root

    // 1. Check if exact .mp3 version exists (common case)
    const mp3Name = basename.replace(/\.(ogg|opus)$/i, '.mp3');
    if (fs.existsSync(path.join(mediaDir, mp3Name))) {
        return `/audio/${mp3Name}`;
    }

    // 2. Fallback to original
    return `/audio/${basename}`;
}

const qdrant = new QdrantClient();

// =============================================================================
// CONFIGURATION
// =============================================================================

let openai = null;
try {
    if (process.env.OPENAI_API_KEY) {
        openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    }
} catch (e) {
    console.error('❌ OpenAI init error:', e.message);
}

// Intent types (from ai_router)
const ROUTER_INTENT = {
    GREETING: 'greeting',
    SIMPLE_FACT: 'simple_fact',
    COMPLEX_ANALYSIS: 'complex_analysis',
    OFF_TOPIC: 'off_topic'
};

// Greeting responses
const GREETING_RESPONSES = [
    "Shalom ! Comment puis-je vous aider avec une question de Halakha ?",
    "Bonjour ! Posez-moi votre question halakhique.",
    "Shalom ! Je suis à votre disposition pour vos questions sur la Loi Juive."
];

// =============================================================================
// SSE HELPERS
// =============================================================================

/**
 * Send SSE event to client
 */
function sendSSE(res, event, data) {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
}

/**
 * Send SSE text chunk
 */
function sendChunk(res, text) {
    sendSSE(res, 'chunk', { text });
}

/**
 * Send SSE metadata
 */
function sendMeta(res, meta) {
    sendSSE(res, 'meta', meta);
}

/**
 * Send SSE done signal
 */
function sendDone(res, stats) {
    sendSSE(res, 'done', stats);
}

/**
 * Send SSE error
 */
function sendError(res, error) {
    sendSSE(res, 'error', { message: error });
}

// =============================================================================
// STREAMING RESPONSE GENERATORS
// =============================================================================

/**
 * Stream simple response (SIMPLE_FACT)
 */
async function streamSimpleResponse(res, query, sources) {
    if (!sources || sources.length === 0) {
        sendChunk(res, "Je n'ai pas trouvé d'information précise sur ce sujet dans les archives du Rav Abichid.");
        return;
    }

    const context = sources.slice(0, 3).map((s, i) =>
        `[Source ${i + 1}]: ${s.question}\nRéponse: ${s.answer}`
    ).join('\n\n');

    try {
        const stream = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            temperature: 0.3,
            max_tokens: 300,
            stream: true,
            messages: [
                {
                    role: 'system',
                    content: `Tu es un assistant halakhique. Réponds de façon CONCISE et DIRECTE.
Utilise UNIQUEMENT les sources fournies. Cite [Source X] si pertinent.
Si la réponse n'est pas dans les sources, dis-le.`
                },
                {
                    role: 'user',
                    content: `Question: ${query}\n\nSOURCES:\n${context}\n\nRéponds en 2-3 phrases maximum.`
                }
            ]
        });

        for await (const chunk of stream) {
            const text = chunk.choices[0]?.delta?.content || '';
            if (text) {
                sendChunk(res, text);
            }
        }
    } catch (error) {
        console.error('❌ Stream simple error:', error.message);
        sendError(res, 'Erreur lors de la génération');
    }
}

/**
 * Stream complex response with Chain-of-Thought (COMPLEX_ANALYSIS)
 */
async function streamComplexResponse(res, query, sources) {
    if (!sources || sources.length === 0) {
        sendChunk(res, "Cette question nécessite une analyse approfondie que je ne peux pas effectuer sans sources pertinentes. Veuillez consulter le Rav Abichid directement.");
        return;
    }

    const context = sources.slice(0, 5).map((s, i) =>
        `[Source ${i + 1}] (Score: ${(s.score * 100).toFixed(0)}%):\nQ: ${s.question}\nR: ${s.answer}`
    ).join('\n\n---\n\n');

    try {
        const stream = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            temperature: 0.4,
            max_tokens: 800,
            stream: true,
            messages: [
                {
                    role: 'system',
                    content: `Tu es un assistant expert en Halakha basé sur les enseignements du Rav Abichid.

MÉTHODE "CHAIN OF THOUGHT" - Tu DOIS suivre ces étapes:

1. **ANALYSE**: Identifie les éléments clés de la question (sujet, contexte, cas particulier)
2. **SOURCES**: Cite les sources pertinentes [Source X] et leur enseignement
3. **COMPARAISON**: Si les sources diffèrent, explique les nuances
4. **CONCLUSION**: Donne la réponse pratique

FORMAT OBLIGATOIRE:
📋 **Analyse de la question**: [ton analyse]
📖 **Sources consultées**: [citations]
⚖️ **Raisonnement**: [comparaison si nécessaire]
✅ **Réponse**: [conclusion pratique]

⚠️ Termine TOUJOURS par: "En cas de doute, consultez le Rav Abichid."`
                },
                {
                    role: 'user',
                    content: `Question: ${query}\n\n=== SOURCES DISPONIBLES ===\n${context}`
                }
            ]
        });

        for await (const chunk of stream) {
            const text = chunk.choices[0]?.delta?.content || '';
            if (text) {
                sendChunk(res, text);
            }
        }
    } catch (error) {
        console.error('❌ Stream complex error:', error.message);
        sendError(res, 'Erreur lors de la génération');
    }
}

// =============================================================================
// MAIN STREAMING ROUTE HANDLER
// =============================================================================

/**
 * Handle streaming request
 */
async function handleStreamingRequest(req, res, query) {
    const startTime = Date.now();

    // ===================
    // Setup SSE Headers
    // ===================
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering
    res.flushHeaders();

    // Send initial connection event
    sendMeta(res, { status: 'connected', query });

    // ===================
    // Step 1: Classify Intent
    // ===================
    sendMeta(res, { step: 'classifying' });
    const classification = await classifyIntent(query);
    sendMeta(res, {
        step: 'classified',
        intent: classification.intent,
        confidence: classification.confidence
    });

    // ===================
    // Step 2: Handle GREETING (no RAG)
    // ===================
    if (classification.intent === ROUTER_INTENT.GREETING) {
        const greeting = GREETING_RESPONSES[Math.floor(Math.random() * GREETING_RESPONSES.length)];
        sendChunk(res, greeting);
        sendDone(res, {
            duration: Date.now() - startTime,
            intent: classification.intent,
            ragSkipped: true
        });
        res.end();
        return;
    }

    // ===================
    // Step 3: Handle OFF_TOPIC
    // ===================
    if (classification.intent === ROUTER_INTENT.OFF_TOPIC) {
        sendChunk(res, "Je suis spécialisé dans les questions de Halakha (Loi Juive). Cette question semble hors de mon domaine d'expertise. 🙏");
        sendDone(res, {
            duration: Date.now() - startTime,
            intent: classification.intent,
            ragSkipped: true
        });
        res.end();
        return;
    }

    // ===================
    // Step 4: RAG Search
    // ===================
    sendMeta(res, { step: 'searching' });
    let sources = [];
    try {
        const limit = classification.intent === ROUTER_INTENT.COMPLEX_ANALYSIS ? 5 : 3;

        // V2 SEARCH: Qdrant Retrieval
        console.log(`🔍 Qdrant Search for: "${query}" (Limit: ${limit})`);

        // 1. Generate Embedding
        const vector = await getEmbedding(query);

        // 2. Search in Qdrant
        const results = await qdrant.search(vector, limit, 0.4); // 0.4 threshhold

        // 3. Format results
        // 3. Enrich & Format results (with DB Lookup for guaranteed content)
        const db = new Database(DB_PATH, { readonly: true });

        sources = results.map(r => {
            let payload = r.payload || {};

            // If missing crucial info, fetch from DB
            if (!payload.answer || !payload.audio_path) {
                try {
                    const row = db.prepare('SELECT transcript_torah, audio_path, question_text, ts FROM messages WHERE id = ?').get(r.id);
                    if (row) {
                        if (!payload.answer) payload.answer = row.transcript_torah;
                        if (!payload.audio_path) payload.audio_path = row.audio_path;
                        if (!payload.question) payload.question = row.question_text;
                        if (!payload.timestamp) payload.timestamp = row.ts;
                    }
                } catch (dbErr) {
                    console.error('⚠️ DB Lookup failed for source', r.id, dbErr.message);
                }
            }

            return {
                id: r.id,
                question: payload.question || 'Question inconnue',
                answer: payload.answer || 'Transcription non disponible',
                score: r.score,
                audio_path: payload.audio_path,
                timestamp: payload.timestamp
            };
        });

        db.close();

        // FALLBACK: If Qdrant returns 0 results (or failed silently), try SQLite Local Search
        if (sources.length === 0) {
            console.log('⚠️ Qdrant returned 0 results. Triggering Local SQLite Fallback...');
            try {
                sources = await searchLocal(query, limit);
                console.log(`✅ Fallback found ${sources.length} sources.`);
            } catch (fallbackErr) {
                console.error('❌ Fallback Search Error:', fallbackErr.message);
            }
        } else {
            console.log(`✅ Qdrant found ${sources.length} sources.`);
        }

    } catch (e) {
        console.error('❌ Qdrant Search Error:', e.message);
        console.log('⚠️ Falling back to Local SQLite Search...');
        try {
            sources = await searchLocal(query, limit);
            console.log(`✅ Fallback found ${sources.length} sources.`);
        } catch (fallbackErr) {
            console.error('❌ Fallback Search Error:', fallbackErr.message);
        }
    }

    sendMeta(res, {
        step: 'found',
        sourcesCount: sources.length,
        sources: sources.slice(0, 3).map(s => ({
            id: s.id,
            question: s.question,
            answer: s.answer,
            audio_path: getAudioUrl(s.audio_path),
            score: Math.round(s.score * 100),
            timestamp: s.timestamp
        }))
    });

    // ===================
    // Step 5: Stream Response
    // ===================
    sendMeta(res, { step: 'generating' });

    if (!openai) {
        // Fallback: no streaming, return raw sources
        const fallback = sources.length > 0
            ? `Voici ce que j'ai trouvé:\n\n${sources.slice(0, 3).map(s => `**Q:** ${s.question}\n**R:** ${s.answer}`).join('\n\n---\n\n')}`
            : "Aucun résultat trouvé.";
        sendChunk(res, fallback);
    } else if (classification.intent === ROUTER_INTENT.SIMPLE_FACT) {
        await streamSimpleResponse(res, query, sources);
    } else {
        // COMPLEX_ANALYSIS - Chain of Thought
        await streamComplexResponse(res, query, sources);
    }

    // ===================
    // Done
    // ===================
    sendDone(res, {
        duration: Date.now() - startTime,
        intent: classification.intent,
        sourcesUsed: sources.length
    });
    res.end();
}

// =============================================================================
// EXPRESS ROUTER SETUP
// =============================================================================

/**
 * Setup V2 streaming routes on Express app
 */
function setupV2StreamingRoutes(app) {
    const express = require('express');

    // ===================
    // POST /api/v2/ask/stream - Streaming SSE endpoint
    // ===================
    app.post('/api/v2/ask/stream', express.json(), async (req, res) => {
        const { query, question } = req.body;
        const userQuery = query || question;

        if (!userQuery || userQuery.trim().length < 3) {
            res.setHeader('Content-Type', 'text/event-stream');
            res.flushHeaders();
            sendError(res, 'Question requise (minimum 3 caractères)');
            res.end();
            return;
        }

        console.log(`🌊 [V2 Stream] Query: "${userQuery.substring(0, 50)}..."`);

        try {
            await handleStreamingRequest(req, res, userQuery);
        } catch (error) {
            console.error('❌ Streaming error:', error);
            if (!res.headersSent) {
                res.setHeader('Content-Type', 'text/event-stream');
                res.flushHeaders();
            }
            sendError(res, 'Erreur interne du serveur');
            res.end();
        }
    });

    // ===================
    // GET /api/v2/ask/stream - GET version for testing
    // ===================
    app.get('/api/v2/ask/stream', async (req, res) => {
        const query = req.query.q || req.query.query;

        if (!query || query.trim().length < 3) {
            res.setHeader('Content-Type', 'text/event-stream');
            res.flushHeaders();
            sendError(res, 'Paramètre q requis (minimum 3 caractères)');
            res.end();
            return;
        }

        console.log(`🌊 [V2 Stream GET] Query: "${query.substring(0, 50)}..."`);

        try {
            await handleStreamingRequest(req, res, query);
        } catch (error) {
            console.error('❌ Streaming error:', error);
            sendError(res, 'Erreur interne du serveur');
            res.end();
        }
    });

    // ===================
    // Non-streaming fallback (for compatibility)
    // ===================
    app.post('/api/v2/ask', express.json(), async (req, res) => {
        const { query, question } = req.body;
        const userQuery = query || question;

        if (!userQuery || userQuery.trim().length < 3) {
            return res.status(400).json({
                success: false,
                error: 'Question requise (minimum 3 caractères)'
            });
        }

        try {
            // Use ai_router for non-streaming
            const { routeAndAnswer } = require('./ai_router');
            const result = await routeAndAnswer(userQuery);
            res.json(result);
        } catch (error) {
            res.status(500).json({
                success: false,
                error: error.message
            });
        }
    });

    console.log('🌊 V2 Streaming routes registered: /api/v2/ask/stream (POST/GET), /api/v2/ask (POST)');
}

// =============================================================================
// EXPORTS
// =============================================================================

module.exports = {
    setupV2StreamingRoutes,
    handleStreamingRequest,
    sendSSE,
    sendChunk,
    sendMeta,
    sendDone,
    sendError
};
