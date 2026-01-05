/**
 * RavQA - Module IA avec RAG strict et recherche ULTRA-pertinente
 * Système amélioré avec scoring de pertinence et comparaison question-à-question
 */

const DB = require('./db');

// Mots vides en français (stop words)
const STOP_WORDS = new Set([
    'le', 'la', 'les', 'un', 'une', 'des', 'du', 'de', 'et', 'ou', 'est', 'ce', 'que', 'qui',
    'pour', 'dans', 'sur', 'par', 'avec', 'je', 'tu', 'il', 'elle', 'nous', 'vous', 'ils',
    'elles', 'on', 'mon', 'ton', 'son', 'ma', 'ta', 'sa', 'mes', 'tes', 'ses', 'notre',
    'votre', 'leur', 'au', 'aux', 'à', 'y', 'en', 'ai', 'as', 'a', 'avons', 'avez', 'ont',
    'suis', 'es', 'sommes', 'êtes', 'sont', 'être', 'avoir', 'fait', 'faire', 'dit', 'dire',
    'peut', 'peuvent', 'doit', 'doivent', 'faut', 'ça', 'cela', 'cette', 'ces', 'cet',
    'si', 'ne', 'pas', 'plus', 'moins', 'très', 'bien', 'aussi', 'mais', 'donc', 'car',
    'quand', 'comment', 'pourquoi', 'quoi', 'quel', 'quelle', 'quels', 'quelles',
    'rav', 'rabbi', 'abichid', 'bonjour', 'merci', 'svp', 'stp', 'question'
]);

// Synonymes et termes liés pour améliorer la compréhension
const SYNONYMS = {
    'shabbat': ['chabbat', 'shabbos', 'samedi'],
    'chabbat': ['shabbat', 'shabbos', 'samedi'],
    'brakha': ['berakha', 'bénédiction', 'brakha', 'benediction'],
    'bénédiction': ['brakha', 'berakha', 'benediction'],
    'casher': ['cacher', 'kasher', 'kosher'],
    'cacher': ['casher', 'kasher', 'kosher'],
    'manger': ['consommer', 'nourriture', 'aliment', 'repas'],
    'prier': ['prière', 'tefila', 'tefilah', 'davener'],
    'prière': ['prier', 'tefila', 'tefilah'],
    'viande': ['bassar', 'basar', 'viande'],
    'lait': ['halav', 'chalav', 'laitier', 'lacté'],
    'allumer': ['allumage', 'lumière', 'bougie', 'nérot'],
    'bougie': ['nérot', 'nerot', 'bougie', 'allumer'],
    'permis': ['autorisé', 'moutar', 'permis', 'peut'],
    'interdit': ['assour', 'assur', 'défendu', 'prohibé'],
    'femme': ['femmes', 'épouse', 'icha', 'dame'],
    'homme': ['hommes', 'mari', 'ich', 'monsieur'],
    'enfant': ['enfants', 'enfant', 'yeled', 'garçon', 'fille'],
    'cuire': ['cuisson', 'cuisiner', 'chauffer', 'plat'],
    'chauffer': ['réchauffer', 'cuire', 'chaleur', 'chaud']
};

// Extraction de mots-clés pertinents avec normalisation
function extractKeywords(text) {
    const words = text
        .toLowerCase()
        .replace(/[^a-zA-Z0-9\u0590-\u05FFàâäéèêëïîôùûüç\s]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 2 && !STOP_WORDS.has(w));

    // Dédupliquer et prendre les plus importants
    const unique = [...new Set(words)];
    return unique.slice(0, 8);
}

// Expandre les synonymes pour une meilleure recherche
function expandSynonyms(keywords) {
    const expanded = new Set(keywords);
    for (const kw of keywords) {
        if (SYNONYMS[kw]) {
            SYNONYMS[kw].forEach(syn => expanded.add(syn));
        }
    }
    return [...expanded];
}

// Calculer le score de similarité entre deux textes
function calculateSimilarity(text1, text2, keywords) {
    if (!text1 || !text2) return 0;

    const t1 = text1.toLowerCase();
    const t2 = text2.toLowerCase();

    // Score 1: Mots-clés de la question présents dans le texte de la source
    const keywordScore = keywords.filter(kw => t2.includes(kw)).length / keywords.length;

    // Score 2: Correspondance de mots entre les textes
    const words1 = new Set(t1.split(/\s+/).filter(w => w.length > 2 && !STOP_WORDS.has(w)));
    const words2 = new Set(t2.split(/\s+/).filter(w => w.length > 2 && !STOP_WORDS.has(w)));

    let matchCount = 0;
    for (const w of words1) {
        if (words2.has(w)) matchCount++;
    }
    const wordMatchScore = words1.size > 0 ? matchCount / words1.size : 0;

    // Score 3: Présence de mots exacts de la question dans la question source
    const exactMatchScore = keywords.filter(kw => t2.includes(kw)).length;

    // Score combiné (pondéré)
    return (keywordScore * 0.5) + (wordMatchScore * 0.3) + (exactMatchScore * 0.2);
}

// Recherche intelligente ultra-pertinente
async function get_context(query) {
    try {
        const db = DB.getDb();
        const originalKeywords = extractKeywords(query);

        if (originalKeywords.length === 0) {
            return { context: null, sources: [], keywords: [] };
        }

        // Expandre avec synonymes pour la recherche
        const expandedKeywords = expandSynonyms(originalKeywords);
        console.log(`🔍 Recherche: ${originalKeywords.join(', ')} (+ synonymes: ${expandedKeywords.length})`);

        let results = [];

        // Stratégie 1: Recherche FTS avec les mots-clés originaux
        if (originalKeywords.length >= 1) {
            const andQuery = originalKeywords.map(w => w + '*').join(' AND ');
            try {
                const andResults = db.prepare(`
                    SELECT m.id, m.question_text, 
                           COALESCE(m.transcript_raw_edited, m.transcript_raw) as transcript_raw,
                           bm25(messages_fts) as fts_score,
                           COALESCE((SELECT SUM(CASE WHEN is_relevant = 1 THEN 2 ELSE -3 END) 
                                     FROM ai_feedback WHERE message_id = m.id), 0) as feedback_score
                    FROM messages m
                    JOIN messages_fts fts ON m.id = fts.rowid
                    WHERE messages_fts MATCH ? AND m.deleted_at IS NULL
                    ORDER BY feedback_score DESC, fts_score
                    LIMIT 15
                `).all(andQuery);
                results = andResults;
            } catch (e) {
                console.log('FTS AND failed:', e.message);
            }
        }

        // Stratégie 2: Recherche OR avec synonymes si peu de résultats
        if (results.length < 5) {
            const orQuery = expandedKeywords.slice(0, 6).map(w => w + '*').join(' OR ');
            try {
                const orResults = db.prepare(`
                    SELECT m.id, m.question_text, 
                           COALESCE(m.transcript_raw_edited, m.transcript_raw) as transcript_raw,
                           bm25(messages_fts) as fts_score,
                           COALESCE((SELECT SUM(CASE WHEN is_relevant = 1 THEN 2 ELSE -3 END) 
                                     FROM ai_feedback WHERE message_id = m.id), 0) as feedback_score
                    FROM messages m
                    JOIN messages_fts fts ON m.id = fts.rowid
                    WHERE messages_fts MATCH ? AND m.deleted_at IS NULL
                    ORDER BY feedback_score DESC, fts_score
                    LIMIT 15
                `).all(orQuery);

                const existingIds = new Set(results.map(r => r.id));
                for (const r of orResults) {
                    if (!existingIds.has(r.id)) {
                        results.push(r);
                    }
                }
            } catch (e) {
                console.log('FTS OR failed:', e.message);
            }
        }

        if (results.length === 0) {
            return { context: null, sources: [], keywords: originalKeywords };
        }

        // ========== SCORING DE PERTINENCE AVANCÉ ==========

        results.forEach(r => {
            // Score 1: Correspondance mots-clés dans la QUESTION source (très important)
            const questionText = (r.question_text || '').toLowerCase();
            const questionMatchCount = originalKeywords.filter(kw => questionText.includes(kw)).length;

            // Score 2: Correspondance dans la RÉPONSE
            const answerText = (r.transcript_raw || '').toLowerCase();
            const answerMatchCount = originalKeywords.filter(kw => answerText.includes(kw)).length;

            // Score 3: Similarité globale question-question
            const similarity = calculateSimilarity(query, r.question_text, originalKeywords);

            // Score 4: Feedback utilisateur (bonus/malus)
            const feedbackBonus = (r.feedback_score || 0) * 0.1;

            // Score final pondéré (question match = 50%, réponse = 30%, similarité = 20%)
            r.relevanceScore = (
                (questionMatchCount / originalKeywords.length) * 50 +
                (answerMatchCount / originalKeywords.length) * 30 +
                similarity * 20 +
                feedbackBonus
            );

            // Pénalité si la question source est trop courte ou générique
            if ((r.question_text || '').length < 15) {
                r.relevanceScore *= 0.5;
            }

            r.questionMatchCount = questionMatchCount;
            r.answerMatchCount = answerMatchCount;
        });

        // Trier par score de pertinence décroissant
        results.sort((a, b) => b.relevanceScore - a.relevanceScore);

        // ========== FILTRAGE ==========
        // Garder les résultats avec un bon score (> 15) et au moins 1 mot-clé correspondant
        const minKeywords = 1;
        const strictResults = results.filter(r =>
            r.relevanceScore >= 15 &&
            (r.questionMatchCount >= minKeywords || r.answerMatchCount >= 2) &&
            r.transcript_raw &&
            r.transcript_raw.length > 20
        );

        // Si pas assez de résultats, prendre les meilleurs disponibles
        const finalResults = strictResults.length >= 1 ? strictResults.slice(0, 5) :
            results.filter(r => r.transcript_raw && r.transcript_raw.length > 20).slice(0, 3);

        if (finalResults.length === 0) {
            return { context: null, sources: [], keywords: originalKeywords };
        }

        console.log(`✅ ${finalResults.length} résultats pertinents (scores: ${finalResults.map(r => r.relevanceScore.toFixed(1)).join(', ')})`);

        // Construire le contexte avec les réponses filtrées
        const context = finalResults.map((r, i) =>
            `[Source ${i + 1}] Score: ${r.relevanceScore.toFixed(0)}/100\nQuestion originale: "${r.question_text || "Question audio"}"\nRéponse du Rav: ${r.transcript_raw}`
        ).join("\n\n---\n\n");

        // Sources pour l'affichage UI
        const sources = finalResults.map(r => ({
            id: r.id,
            question: (r.question_text || 'Question audio').substring(0, 120) + ((r.question_text?.length || 0) > 120 ? '...' : ''),
            answer: r.transcript_raw.substring(0, 350) + (r.transcript_raw.length > 350 ? '...' : ''),
            hasTranscript: true,
            relevanceScore: Math.round(r.relevanceScore),
            matchCount: r.questionMatchCount
        }));

        return { context, sources, keywords: originalKeywords };
    } catch (e) {
        console.error("Erreur Context DB:", e);
        return { context: null, sources: [], keywords: [] };
    }
}

// Génère une réponse structurée basée sur les données du Rav
async function get_rav_response(inputText, model = 'local') {
    const { context, sources, keywords } = await get_context(inputText);

    if (!context) {
        return {
            ok: false,
            response: `❌ **Aucune réponse pertinente trouvée** pour votre question.

Les sources disponibles ne correspondent pas directement à : "${inputText}"

💡 **Suggestions :**
- Reformulez avec des termes plus précis
- Utilisez des mots hébraïques translittérés (ex: "shabbat", "brakha")
- Posez une question plus spécifique`,
            sources: [],
            keywords
        };
    }

    const systemPrompt = `Tu es un assistant qui transmet FIDÈLEMENT les réponses du Rav Abichid.

🎯 MISSION : Répondre UNIQUEMENT avec le contenu des sources fournies.

📋 RÈGLES STRICTES :
1. CITE TEXTUELLEMENT les réponses du Rav avec des guillemets « »
2. Indique toujours (Source X) après chaque citation
3. Si les sources ne répondent PAS à la question → Dis-le clairement
4. N'INVENTE RIEN - utilise UNIQUEMENT les sources

📝 FORMAT DE RÉPONSE :
📖 **Réponse du Rav Abichid :**

Le Rav explique que « [citation exacte] » (Source 1).

[Si plusieurs sources pertinentes, les combiner]

⚠️ *Vérifiez auprès du Rav pour confirmation.*

🚫 INTERDIT :
- Inventer ou extrapoler au-delà des sources
- Répondre si aucune source n'est pertinente
- Donner ton avis personnel`;

    const userPrompt = `QUESTION POSÉE : "${inputText}"
MOTS-CLÉS DÉTECTÉS : ${keywords.join(', ')}

SOURCES À UTILISER (cite-les avec des guillemets) :
${context}

CONSIGNE : Réponds en citant TEXTUELLEMENT les passages pertinents. Si aucune source ne répond à la question, dis-le clairement.`;

    try {
        let response;

        if (model === 'gpt') {
            const OpenAI = require('openai');
            const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

            const completion = await openai.chat.completions.create({
                model: 'gpt-4o-mini',
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt }
                ],
                temperature: 0.3, // Plus bas = plus fidèle aux sources
                max_tokens: 1000
            });
            response = completion.choices[0].message.content;
        } else {
            // Mode local - réponse simple basée sur les sources
            response = `📖 **Réponse basée sur ${sources.length} source(s) du Rav Abichid :**\n\n`;
            for (let i = 0; i < Math.min(sources.length, 3); i++) {
                const s = sources[i];
                response += `**Source ${i + 1}** (pertinence: ${s.relevanceScore}%)\n`;
                response += `Question: *${s.question}*\n`;
                response += `Réponse: « ${s.answer} »\n\n`;
            }
            response += `⚠️ *Vérifiez auprès du Rav Abichid pour confirmation.*`;
        }

        return { ok: true, response, sources, keywords };
    } catch (e) {
        console.error("Erreur API IA:", e);
        return {
            ok: false,
            response: `Erreur technique: ${e.message}`,
            sources,
            keywords
        };
    }
}

module.exports = { get_rav_response, get_context, extractKeywords };
