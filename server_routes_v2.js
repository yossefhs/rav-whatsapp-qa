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
    // Always extract just the filename and force .mp3 extension for Safari compatibility
    const mp3Name = path.basename(audioPath).replace(/\.(ogg|opus)$/i, '.mp3');

    // CLOUD MODE (Railway): proxy via /audio-b2/ route which fetches from private B2 bucket
    if (process.env.B2_BUCKET_NAME) {
        return `/audio-b2/${mp3Name}`;
    }

    // LEGACY CLOUD MODE: direct public CDN URL (e.g. public Backblaze bucket)
    const baseUrl = process.env.MEDIA_BASE_URL;
    if (baseUrl) {
        return `${baseUrl.replace(/\/$/, '')}/${mp3Name}`;
    }

    // LOCAL MODE: serve via Express /audio/ route (with ffmpeg fallback)
    return `/audio/${mp3Name}`;
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
 * Analyse et reformule la question
 */
async function analyzeAndRefineQuery(question) {
    if (!openai) return question;
    try {
        const completion = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [
                {
                    role: 'system',
                    content: `Tu es un expert en recherche. Reformule la question pour maximiser la pertinence (mots clés hébreux, précision). Retourne uniquement la question.`
                },
                { role: 'user', content: question }
            ],
            temperature: 0.3
        });
        return completion.choices[0].message.content.trim();
    } catch (e) {
        return question;
    }
}

const { getSefariaTopicSources, getSefariaText } = require('./sefaria');

/**
 * Stream simple response (SIMPLE_FACT)
 */
async function streamSimpleResponse(res, query, sources, sefariaContext = "") {
    if (!sources || sources.length === 0) {
        sendChunk(res, "Je n'ai pas trouvé d'information précise sur ce sujet dans les archives du Rav Abichid.");
        return;
    }

    const context = sources.slice(0, 5).map((s, i) =>
        `[Source ${i + 1}]: ${s.question}\nRéponse: ${s.answer}`
    ).join('\n\n');

    let fullContext = context;
    if (sefariaContext) {
        fullContext += `\n\n=== CONTEXTE SEFARIA ===\n${sefariaContext}`;
    }

    try {
        console.log(`[DEBUG Stream] Requesting completion from OpenAI for streamSimpleResponse...`);
        const stream = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            temperature: 0.3,
            max_tokens: 600,
            stream: true,
            messages: [
                {
                    role: 'system',
                    content: `Tu es un assistant halakhique spécialisé dans les enseignements du Rav Abichid.

Tu dois TOUJOURS structurer ta réponse ainsi :

**ÉTAPE 1 – Compréhension halakhique** (obligatoire, court):
Identifie le sujet halakhique de la question. Cite brièvement (1-2 phrases) une référence Sefaria pertinente (ex: Choulhan Aroukh) pour cadrer la problématique.

**ÉTAPE 2 – Psak du Rav Abichid** (CRUCIAL):
Cite directement les enseignements du Rav Abichid d'après les Sources fournies.
TU DOIS OBLIGATOIREMENT CITER LE NUMÉRO DE LA SOURCE dans ton texte au format [Source X].
Exemple: "Selon le Rav Abichid [Source 1], il est permis de..." ou "Dans la [Source 2], le Rav précise que..."
⚠️ ATTENTION: N'utilise QUE les sources qui répondent directement et précisément à la question. Si les sources parlent d'un sujet similaire mais ne traitent pas le cas exact de l'utilisateur, NE LES UTILISE PAS et passe directement à l'étape 3.

**ÉTAPE 3 – Conclusion** :
- SI des sources pertinentes du Rav Abichid existent : conclure d'après sa réponse.
- SI aucune source ne couvre EXACTEMENT la question : AJOUTER obligatoirement : "⚠️ Il n'y a pas de réponse directe du Rav Abichid sur ce cas exact dans les archives. Veuillez vérifier auprès du Rav."

REMARQUE: Si la question est ambiguë, demande une précision.`
                },
                {
                    role: 'user',
                    content: `Question: ${query}\n\nSOURCES ARCHIVES RAV ABICHID:\n${fullContext}`
                }
            ]
        });

        console.log(`[DEBUG Stream] OpenAI stream successfully established. Reading chunks...`);
        let count = 0;
        for await (const chunk of stream) {
            count++;
            if (count === 1) console.log(`[DEBUG Stream] First chunk received from OpenAI!`);
            const text = chunk.choices[0]?.delta?.content || '';
            if (text) {
                sendChunk(res, text);
                if (res.flush) res.flush(); // Force flush if supported
            }
        }
        console.log(`[DEBUG Stream] Finished reading OpenAI stream. Total generated chunks: ${count}`);
    } catch (error) {
        console.error('❌ Stream simple error:', error.message);
        sendError(res, 'Erreur lors de la génération');
    }
}

/**
 * Stream complex response with Chain-of-Thought (COMPLEX_ANALYSIS)
 */
async function streamComplexResponse(res, query, sources, sefariaContext = "") {
    if (!sources || sources.length === 0) {
        sendChunk(res, "Cette question nécessite une analyse approfondie que je ne peux pas effectuer sans sources pertinentes. Veuillez consulter le Rav Abichid directement.");
        return;
    }

    const context = sources.slice(0, 5).map((s, i) =>
        `[Source ${i + 1}] (Score: ${(s.score * 100).toFixed(0)}%):\nQ: ${s.question}\nR: ${s.answer}`
    ).join('\n\n---\n\n');

    let fullContext = context;
    if (sefariaContext) {
        fullContext += `\n\n=== CONTEXTE SEFARIA ===\n${sefariaContext}`;
    }

    try {
        const stream = await openai.chat.completions.create({
            model: 'gpt-4o',
            temperature: 0.2,
            max_tokens: 1500,
            stream: true,
            messages: [
                {
                    role: 'system',
                    content: `Tu es un assistant halakhique expert, représentant exclusivement les enseignements et la base de données du Rav Abichid. Ton objectif absolu est de fournir la réponse du Rav Abichid en t'appuyant strictement sur les sources.

---

📖 **RÈGLE CRUCIALE SUR SEFARIA** : 
Sefaria ne doit servir QU'À T'AIDER à analyser et comprendre la question (définir les termes, donner un bref contexte halakhique). La réponse finale et le Psak (décision) DOIVENT TOUJOURS ÊTRE PRINCIPALEMENT TIRÉS DE LA BASE DE DONNÉES DU RAV ABICHID.

---

📚 Tu dois TOUJOURS structurer ta réponse ainsi :

**1. COMPRÉHENSION DE LA QUESTION (Très Court)**:
Cite rapidement le contexte halakhique grâce aux sources Sefaria pour expliquer le sujet.

**2. LE PSAK DU RAV ABICHID (Avec Citations Obligatoires)**:
Amène la réponse directement d'après les [Source X] de la base de données du Rav Abichid.
TU DOIS ABSOLUMENT insérer les références [Source 1], [Source 2], etc. dans tes phrases pour prouver d'où tu tires l'information.
⚠️ ATTENTION: Tu dois être extrêmement strict sur la pertinence. Si la [Source X] mentionne le même grand sujet (ex: le Shabbat) mais ne répond PAS à la question précise posée, ignore-la totalement.

**3. CONCLUSION DÉFINITIVE** :
- **Si le Rav Abichid a répondu au cas précis** → Conclure UNIQUEMENT d'après les réponses du Rav.
- **Si aucune source ne répond exactement à la question** → Conclure brièvement d'après Sefaria, MAIS tu dois OBLIGATOIREMENT mentionner : "Sous réserve de demander au Rav Abichid, car nous n'avons pas d'archives détaillant ce cas précis."

⚠️ Termine TOUJOURS ta réponse par : "En cas de doute ou pour un cas précis, posez la question directement au Rav Abichid."`
                },
                {
                    role: 'user',
                    content: `Question: ${query}\n\n=== SOURCES DISPONIBLES ===\n${fullContext}`
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

    // 0. REFINE QUERY (Auto-Correction)
    sendMeta(res, { step: 'Reformulation...' });
    const refined = await analyzeAndRefineQuery(query);
    if (refined && refined !== query) {
        console.log(`✨ Refined: "${query}" -> "${refined}"`);
        query = refined;
    }

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
        const limit = classification.intent === ROUTER_INTENT.COMPLEX_ANALYSIS ? 7 : 5;

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
                audio_path: getAudioUrl(payload.audio_path),
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

    // ===================
    // Step 5: Sefaria Enrichment
    // ===================
    sendMeta(res, { step: 'enriching' });
    let sefariaContext = "";

    if (openai && (classification.intent === ROUTER_INTENT.SIMPLE_FACT || classification.intent === ROUTER_INTENT.COMPLEX_ANALYSIS)) {
        try {
            // Find Halakhic topic slug
            const topicResponse = await openai.chat.completions.create({
                model: 'gpt-4o-mini',
                messages: [
                    {
                        role: 'system',
                        content: `Extract the main Halakhic topic from the question in ONE SINGLE ENGLISH WORD (e.g. "shabbat", "kashrut", "niddah", "kiddush", "tefillah"). If none applies directly, output "general".`
                    },
                    { role: 'user', content: query }
                ],
                temperature: 0,
                max_tokens: 10
            });
            const slug = topicResponse.choices[0].message.content.trim().toLowerCase();

            if (slug !== 'general') {
                console.log(`📚 Sefaria Topic identified: ${slug}`);
                const refs = await getSefariaTopicSources(slug);
                if (refs && refs.length > 0) {
                    // Fetch text for the first 2 primary sources to keep context size manageable
                    const texts = await Promise.all(refs.slice(0, 2).map(r => getSefariaText(r)));
                    sefariaContext = texts.filter(t => t !== null).join('\n\n');
                }
            }
            console.log(`[DEBUG Stream] Sefaria block completed. Slug was: ${slug || 'none'}`);
        } catch (e) {
            console.error('❌ Sefaria enrichment error:', e.message);
        }
    }

    console.log(`[DEBUG Stream] Preparing 'found' payload with ${sources.length} sources...`);

    try {
        const foundPayload = {
            step: 'found',
            sourcesCount: sources.length,
            sources: sources.slice(0, 5).map(s => ({
                id: s.id,
                question: s.question,
                answer: s.answer,
                audio_path: getAudioUrl(s.audio_path),
                score: s.score ? Math.round(s.score * 100) : 0,
                timestamp: s.timestamp || Date.now()
            }))
        };
        console.log(`[DEBUG Stream] Payload array mapped successfully.`);
        sendMeta(res, foundPayload);
        console.log(`[DEBUG Stream] 'found' event sent to SSE.`);
    } catch (mapErr) {
        console.error(`❌ Error mapping sources:`, mapErr);
    }

    // ===================
    // Step 6: Stream Response
    // ===================
    console.log(`[DEBUG Stream] Sending 'generating' event.`);
    sendMeta(res, { step: 'generating' });

    if (!openai) {
        // Fallback: no streaming, return raw sources
        const fallback = sources.length > 0
            ? `Voici ce que j'ai trouvé:\n\n${sources.slice(0, 5).map(s => `**Q:** ${s.question}\n**R:** ${s.answer}`).join('\n\n---\n\n')}`
            : "Aucun résultat trouvé.";
        sendChunk(res, fallback);
    } else if (classification.intent === ROUTER_INTENT.SIMPLE_FACT) {
        await streamSimpleResponse(res, query, sources, sefariaContext);
    } else {
        // COMPLEX_ANALYSIS - Chain of Thought
        await streamComplexResponse(res, query, sources, sefariaContext);
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
