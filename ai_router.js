/**
 * AI Router - Le Cerveau Agentique (Mission 2)
 * 
 * Point d'entrée intelligent qui:
 * 1. Classifie l'intention via GPT-4o-mini (rapide & économique)
 * 2. Route vers la stratégie appropriée
 * 3. Applique Chain-of-Thought pour les analyses complexes
 * 
 * @author RavQA V2
 */

require('dotenv').config();
const OpenAI = require('openai');

// Import existing V1 RAG (will be replaced by V2 when ready)
const { searchLocal } = require('./rag_api');
// Import rule-based router for fallback
const { classifyIntent: classifyIntentRules, INTENT } = require('./intent_router_v2');

// =============================================================================
// CONFIGURATION
// =============================================================================

let openai = null;
try {
    if (process.env.OPENAI_API_KEY) {
        openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    } else {
        console.warn('⚠️ OPENAI_API_KEY non défini - AI Router en mode dégradé');
    }
} catch (e) {
    console.error('❌ OpenAI init error:', e.message);
}

// Intent types
const ROUTER_INTENT = {
    GREETING: 'greeting',
    SIMPLE_FACT: 'simple_fact',
    COMPLEX_ANALYSIS: 'complex_analysis',
    OFF_TOPIC: 'off_topic'
};

// Greeting responses (no RAG needed)
const GREETING_RESPONSES = [
    "Shalom ! Comment puis-je vous aider avec une question de Halakha ?",
    "Bonjour ! Posez-moi votre question halakhique.",
    "Shalom ! Je suis à votre disposition pour vos questions sur la Loi Juive.",
    "Bienvenue ! Quelle est votre question ?"
];

// =============================================================================
// GPT-BASED INTENT CLASSIFICATION
// =============================================================================

/**
 * Classifie l'intention de la requête utilisateur via GPT-4o-mini
 * @param {string} userQuery - La requête brute
 * @returns {Promise<{intent: string, confidence: number, reasoning: string}>}
 */
async function classifyIntent(userQuery) {
    // Fallback if no OpenAI
    if (!openai) {
        console.log('⚠️ OpenAI indisponible, fallback vers règles');
        const ruleResult = classifyIntentRules(userQuery);
        return {
            intent: mapRuleIntentToRouter(ruleResult.intent),
            confidence: ruleResult.confidence,
            reasoning: 'Fallback to rule-based classification',
            method: 'rules'
        };
    }

    const startTime = Date.now();

    try {
        const response = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            temperature: 0,
            max_tokens: 150,
            response_format: { type: 'json_object' },
            messages: [
                {
                    role: 'system',
                    content: `Tu es un classificateur d'intentions pour un assistant halakhique.
                    
Analyse la requête et retourne un JSON avec:
{
    "intent": "GREETING" | "SIMPLE_FACT" | "COMPLEX_ANALYSIS" | "OFF_TOPIC",
    "confidence": 0.0-1.0,
    "reasoning": "Explication courte"
}

DÉFINITIONS:
- GREETING: Salutations, remerciements, bavardage ("Bonjour", "Merci Rav", "Shalom")
- SIMPLE_FACT: Question factuelle simple, une seule réponse claire ("Horaire Shabbat Paris", "Quelle bracha pour une pomme?")
- COMPLEX_ANALYSIS: Nécessite comparaison de sources, raisonnement halakhique, cas pratique nuancé ("Puis-je réchauffer un plat sur la plata si...", "Mon fils a fait X, que faire?")
- OFF_TOPIC: Hors sujet halakhique (politique, météo, sport)

Sois STRICT: si c'est une vraie question halakhique avec contexte, c'est COMPLEX_ANALYSIS.`
                },
                {
                    role: 'user',
                    content: userQuery
                }
            ]
        });

        const result = JSON.parse(response.choices[0].message.content);
        const duration = Date.now() - startTime;

        console.log(`🧠 Intent classified in ${duration}ms: ${result.intent} (${(result.confidence * 100).toFixed(0)}%)`);

        return {
            intent: result.intent.toLowerCase(),
            confidence: result.confidence || 0.8,
            reasoning: result.reasoning || '',
            method: 'gpt',
            duration
        };
    } catch (error) {
        console.error('❌ GPT classification error:', error.message);
        // Fallback to rules
        const ruleResult = classifyIntentRules(userQuery);
        return {
            intent: mapRuleIntentToRouter(ruleResult.intent),
            confidence: ruleResult.confidence * 0.8, // Lower confidence for fallback
            reasoning: 'Fallback after GPT error',
            method: 'rules_fallback'
        };
    }
}

/**
 * Map rule-based intents to router intents
 */
function mapRuleIntentToRouter(ruleIntent) {
    switch (ruleIntent) {
        case INTENT.FACTUAL:
            return ROUTER_INTENT.SIMPLE_FACT;
        case INTENT.CONCEPTUAL:
        case INTENT.PROCEDURAL:
            return ROUTER_INTENT.COMPLEX_ANALYSIS;
        case INTENT.NAVIGATION:
            return ROUTER_INTENT.OFF_TOPIC;
        default:
            return ROUTER_INTENT.COMPLEX_ANALYSIS; // Default to complex for safety
    }
}

// =============================================================================
// RESPONSE GENERATION
// =============================================================================

const path = require('path');
const fs = require('fs');

// Helper to get correct Audio URL (MP3 preferred)
function getAudioUrl(audioPath) {
    if (!audioPath) return null;
    const basename = path.basename(audioPath);
    const mediaDir = path.join(__dirname, 'media');

    // 1. Check exact match
    if (fs.existsSync(path.join(mediaDir, basename))) {
        return `https://v2.ravabichid.fr/audio/${basename}`; // Hardcoded Public URL for WhatsApp
    }

    // 2. Check MP3 version
    const mp3Name = basename.replace(/\.(ogg|opus)$/i, '.mp3');
    if (fs.existsSync(path.join(mediaDir, mp3Name))) {
        return `https://v2.ravabichid.fr/audio/${mp3Name}`;
    }

    // Return relative if no domain known (bot.js might handle it locally if file, but usually users want links)
    // Assuming we want a clickable link in WhatsApp. If local file, we can't link it easily unless we upload it.
    // Bot V2 uses 'routeAndAnswer' -> text.
    // If we want actual audio FILES sent, bot.js needs to handle it.
    // User said "amene bien les reponses source ... avec l audio".
    // "Audio" could mean the link.
    // Let's provide the filename/link.
    return basename;
}
// Note: Ideally, we should use the domain/IP. For now, let's stick to appending text details.

// ... (existing imports)

// =============================================================================
// RESPONSE GENERATION
// =============================================================================

// =============================================================================
// QUERY REFINEMENT (To improve relevance)
// =============================================================================

/**
 * Analyse et reformule la question pour optimiser la recherche vectorielle
 * (Query Expansion / HyDE Lite)
 */
async function analyzeAndRefineQuery(question) {
    if (!openai) return question;

    // Skip if very short
    if (question.length < 10) return question;

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
4. Garde la question en Français.

Retourne UNIQUEMENT la nouvelle question reformulée.`
                },
                { role: 'user', content: question }
            ],
            temperature: 0.3,
            max_tokens: 150
        });

        const refinedQuery = completion.choices[0].message.content.trim();
        console.log(`🔍 Query Refined: "${question}" -> "${refinedQuery}"`);
        return refinedQuery;
    } catch (error) {
        console.error('Query refinement error:', error.message);
        return question; // Fallback to original
    }
}

// =============================================================================
// RESPONSE GENERATION
// =============================================================================

/**
 * Génère une réponse simple basée sur les sources RAG
 */
async function generateSimpleResponse(query, sources) {
    if (!sources || sources.length === 0) {
        return "Je n'ai pas trouvé d'information précise sur ce sujet dans les archives du Rav Abichid.";
    }

    // Use up to 10 sources
    const context = sources.slice(0, 10).map((s, i) =>
        `[Source ${i + 1}]: ${s.question}\nRéponse: ${s.answer}`
    ).join('\n\n');

    const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        temperature: 0.3,
        max_tokens: 400,
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

    return response.choices[0].message.content;
}

/**
 * Génère une réponse complexe avec Chain-of-Thought
 */
async function generateComplexResponse(query, sources) {
    if (!sources || sources.length === 0) {
        return {
            answer: "Cette question nécessite une analyse approfondie que je ne peux pas effectuer sans sources pertinentes. Veuillez consulter le Rav Abichid directement.",
            reasoning: null
        };
    }

    // Use up to 10 sources for context
    const context = sources.slice(0, 10).map((s, i) =>
        `[Source ${i + 1}] (Score: ${(s.score * 100).toFixed(0)}%):\nQ: ${s.question}\nR: ${s.answer}`
    ).join('\n\n---\n\n');

    const response = await openai.chat.completions.create({
        // ULTRA INTELLIGENT MODE: Uses GPT-4o for maximum reasoning capability
        model: 'gpt-4o',
        temperature: 0.2, // Lower temperature for more precision
        max_tokens: 1200,
        messages: [
            {
                role: 'system',
                content: `Tu es un Expert Décisionnaire en Halakha (Posqim), basé EXCLUSIVEMENT sur les enseignements du Rav Abichid.
Ton objectif est de fournir une réponse d'une précision chirurgicale ("Ultra Intelligent").

RÈGLES D'OR :
1. **FIDÉLITÉ ABSOLUE** : Ne dis jamais rien qui ne soit pas explicitement soutenu par les sources fournies.
2. **NUANCE & PRÉCISION** : Si deux sources semblent se contredire, analyse pourquoi (contexte différent ? cas différent ?). Ne simplifie pas à outrance.
3. **TRANSPARENCE** : Si une information manque pour trancher, dis-le clairement.

MÉTHODE DE RAISONNEMENT (Chain of Thought) :
1. **DÉCONSTRUCTION** : Analyse la question sous tous ses angles (halakhiques, pratiques).
2. **EXTRACTION** : Pour chaque point, identifie la source exacte (ex: [Source 2]).
3. **SYNTHÈSE LOGIQUE** : Construis la réponse étape par étape.
4. **CONCLUSION PRATIQUE** : Termine par une décision claire (Assour/Moutar/Disctinction).

FORMAT DE RÉPONSE ATTENDU :
📋 **Analyse** : [Résumé du cas halakhique]
📖 **Étude des Sources** : 
  - Selon [Source X], ...
  - En revanche/De même, [Source Y] précise que ...
⚖️ **Raisonnement** : [Ton analyse des sources pour ce cas précis]
✅ **Halakha Pratique** : [Conclusion directe et applicable]

⚠️ Termine TOUJOURS par : "En cas de doute, ou pour des cas complexes non couverts ici, consultez le Rav Abichid."`
            },
            {
                role: 'user',
                content: `Question: ${query}\n\n=== SOURCES RÉFÉRENCES (RAV ABICHID) ===\n${context}`
            }
        ]
    });

    return {
        answer: response.choices[0].message.content,
        reasoning: 'chain_of_thought_v2'
    };
}

// =============================================================================
// MAIN ROUTER FUNCTION
// =============================================================================

/**
 * Point d'entrée principal - Route et répond intelligemment
 * @param {string} userQuery - La requête utilisateur
 * @returns {Promise<{success: boolean, intent: string, answer: string, sources: Array, stats: Object}>}
 */
async function routeAndAnswer(userQuery) {
    const startTime = Date.now();
    const stats = { steps: [] };

    // ===================
    // Step 1: Classify Intent
    // ===================
    const classification = await classifyIntent(userQuery);
    stats.steps.push({ name: 'classification', duration: classification.duration || 0 });
    stats.intent = classification.intent;
    stats.intentMethod = classification.method;

    // ===================
    // Step 2: Handle GREETING (no RAG)
    // ===================
    if (classification.intent === ROUTER_INTENT.GREETING) {
        const greetingResponse = GREETING_RESPONSES[Math.floor(Math.random() * GREETING_RESPONSES.length)];
        return {
            success: true,
            intent: classification.intent,
            answer: greetingResponse,
            sources: [],
            stats: {
                ...stats,
                totalDuration: Date.now() - startTime,
                ragSkipped: true
            }
        };
    }

    // ===================
    // Step 3: Handle OFF_TOPIC
    // ===================
    if (classification.intent === ROUTER_INTENT.OFF_TOPIC) {
        return {
            success: false,
            intent: classification.intent,
            answer: "Je suis spécialisé dans les questions de Halakha (Loi Juive). Cette question semble hors de mon domaine d'expertise.",
            sources: [],
            stats: {
                ...stats,
                totalDuration: Date.now() - startTime,
                ragSkipped: true
            }
        };
    }

    // ===================
    // Step 4: RAG Search (for SIMPLE_FACT and COMPLEX_ANALYSIS)
    // ===================
    const ragStart = Date.now();
    let sources = [];

    // REFINE QUERY for better relevance
    const refinedQuery = await analyzeAndRefineQuery(userQuery);

    try {
        // Use refined query for search
        sources = await searchLocal(refinedQuery, 10);
    } catch (e) {
        console.error('❌ RAG search error:', e.message);
    }
    stats.steps.push({ name: 'rag_search', duration: Date.now() - ragStart });
    stats.sourcesFound = sources.length;

    // ===================
    // Step 5: Generate Response based on Intent
    // ===================
    const genStart = Date.now();
    let answer = '';
    let reasoning = null;

    if (!openai) {
        // No OpenAI - return raw sources
        answer = sources.length > 0
            ? `Voici ce que j'ai trouvé:\n\n${sources.slice(0, 5).map(s => `Q: ${s.question}\nR: ${s.answer}`).join('\n\n---\n\n')}`
            : "Aucun résultat trouvé.";
    } else if (classification.intent === ROUTER_INTENT.SIMPLE_FACT) {
        answer = await generateSimpleResponse(userQuery, sources);
    } else {
        // COMPLEX_ANALYSIS - Use Chain of Thought
        const complexResult = await generateComplexResponse(userQuery, sources);
        answer = complexResult.answer;
        reasoning = complexResult.reasoning;
    }
    stats.steps.push({ name: 'generation', duration: Date.now() - genStart });

    // ===================
    // Step 6: Append Sources & Audio (Formatting for Whatsapp)
    // ===================
    // Filter to used sources or all if short?
    // User request: "amene bien les reponses source ... avec l audio ... si plus que 3 amenes les toute"

    // We will append details for ALL sources retrieved (up to 10) that were likely relevant.
    // Ideally, we'd know which ones GPT used, but without structured output it's hard.
    // Strategy: Append ALL fetched sources (since searchLocal is already ranked).

    if (sources.length > 0) {
        answer += `\n\n📚 *Sources Citées & Audios:*`;
        sources.forEach((s, i) => {
            const audioUrl = getAudioUrl(s.audio_path);
            const audioIndication = audioUrl ? `\n🔊 Audio: ${audioUrl}` : '';
            // SHOW MORE TRANSCRIPTION (User request: "il n y a pas la transcription")
            // Increased to 400 chars, or full if shorter
            let transcriptText = s.answer ? s.answer.trim() : 'Texte indisponible';
            if (transcriptText.length > 400) {
                transcriptText = transcriptText.substring(0, 400) + '...';
            }

            answer += `\n\n*[${i + 1}]* ${s.question}\n_${transcriptText}_${audioIndication}`;
        });
    }

    // ===================
    // Return Final Result
    // ===================
    return {
        success: true,
        intent: classification.intent,
        intentConfidence: classification.confidence,
        answer,
        reasoning,
        sources: sources.map(s => ({
            id: s.id,
            question: s.question,
            answer: s.answer,
            score: s.score,
            audio_url: getAudioUrl(s.audio_path)
        })),
        disclaimer: "⚠️ Cette réponse est générée par IA. En cas de doute, consultez le Rav Abichid.",
        stats: {
            ...stats,
            totalDuration: Date.now() - startTime
        }
    };
}

// =============================================================================
// EXPRESS ENDPOINTS
// =============================================================================

function setupAIRouterEndpoints(app) {
    const express = require('express');

    // POST /api/v2/ask - New V2 endpoint
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
            console.log(`🚀 [V2] Query: "${userQuery.substring(0, 50)}..."`);
            const result = await routeAndAnswer(userQuery);
            console.log(`✅ [V2] Responded in ${result.stats.totalDuration}ms (${result.intent})`);
            res.json(result);
        } catch (error) {
            console.error('❌ AI Router error:', error);
            res.status(500).json({
                success: false,
                error: 'Erreur interne du routeur AI',
                message: error.message
            });
        }
    });

    // GET /api/v2/classify - Debug endpoint for classification
    app.get('/api/v2/classify', async (req, res) => {
        const query = req.query.q;
        if (!query) {
            return res.status(400).json({ error: 'Paramètre q requis' });
        }

        const result = await classifyIntent(query);
        res.json(result);
    });

    console.log('🧠 AI Router V2 endpoints registered: /api/v2/ask, /api/v2/classify');
}

// =============================================================================
// EXPORTS
// =============================================================================

module.exports = {
    ROUTER_INTENT,
    classifyIntent,
    routeAndAnswer,
    setupAIRouterEndpoints
};
