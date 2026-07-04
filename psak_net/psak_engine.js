/**
 * Moteur "Psak Net" — politique de décision à 3 verdicts pour le bot Rav Abichid.
 *
 * Verdicts :
 *   A (PSAK_CONFIRME)  → le Rav a déjà répondu à CETTE question ; on CITE sa réponse, sans réserve.
 *   B (QUESTION_PROCHE) → question similaire mais pas identique ; on cite en signalant l'écart.
 *   C (AUCUNE_SOURCE)  → rien de prouvé ; on dit clairement de poser la question au Rav.
 *
 * Règle d'or : la netteté vient de la certitude de la donnée, pas du ton.
 * Le moteur ne rédige JAMAIS de halakha — il cite, il signale, ou il se tait.
 *
 * Portable : aucune dépendance (fetch natif Node >= 18). Voir INTEGRATION.md.
 */

const CONFIG = {
    SEUIL_PSAK_CONFIRME: parseFloat(process.env.PSAK_SEUIL_CONFIRME || '0.90'),
    SEUIL_PROCHE: parseFloat(process.env.PSAK_SEUIL_PROCHE || '0.75'),
    SEUIL_LIEN_FIABLE: parseFloat(process.env.PSAK_SEUIL_LIEN || '0.80'),
    JUDGE_MODEL: process.env.PSAK_JUDGE_MODEL || 'claude-opus-4-8',
    FLAG_TRANSCRIPTION: "[PASSAGE INCOMPRÉHENSIBLE À VÉRIFIER SUR L'AUDIO]",
    MAX_CANDIDATS_JUGES: 3,
};

const VERDICT = {
    PSAK_CONFIRME: 'A',
    QUESTION_PROCHE: 'B',
    AUCUNE_SOURCE: 'C',
    SYSTEME_DEGRADE: 'D', // recherche sémantique down → on s'abstient, on ne dégrade pas en silence
};

// =============================================================================
// FILTRES DURS (conditions non négociables pour qu'un candidat soit "citable")
// =============================================================================

function lienFiable(c) {
    if (c.linkMethod === 'reply') return true; // lien WhatsApp direct = prouvé
    return typeof c.linkConfidence === 'number' && c.linkConfidence >= CONFIG.SEUIL_LIEN_FIABLE;
}

function transcriptionSaine(c) {
    const t = (c.answer || '').trim();
    if (t.length < 20) return false;
    if (t.includes(CONFIG.FLAG_TRANSCRIPTION)) return false;
    return true;
}

/**
 * Un candidat "citable" peut produire un Verdict A.
 * Un candidat sain mais au lien non prouvé plafonne au Verdict B.
 */
function classerCandidat(c) {
    if (!transcriptionSaine(c)) return 'inutilisable';
    if (!lienFiable(c)) return 'plafonne_B';
    return 'citable';
}

// =============================================================================
// JUGE LLM — la nouvelle question correspond-elle VRAIMENT à la Q/R retrouvée ?
// =============================================================================

const JUDGE_SCHEMA = {
    type: 'object',
    properties: {
        verdict: { type: 'string', enum: ['MATCH_EXACT', 'MATCH_PROCHE', 'NO_MATCH'] },
        raison: { type: 'string' },
    },
    required: ['verdict', 'raison'],
    additionalProperties: false,
};

const JUDGE_SYSTEM = `Tu es un juge de correspondance pour un service de questions halakhiques.
On te donne une NOUVELLE question et une PAIRE (question déjà posée au Rav + sa réponse).
Ta seule mission : dire si la réponse du Rav tranche EXACTEMENT le cas de la nouvelle question.

- MATCH_EXACT : même cas halakhique, mêmes paramètres décisifs (personne, aliment, moment,
  circonstance...). La réponse du Rav s'applique telle quelle, sans extrapolation.
- MATCH_PROCHE : même sujet mais un paramètre décisif diffère (avant/pendant Chabbat,
  homme/femme, cru/cuit, quantité, urgence...) OU la réponse ne couvre qu'une partie du cas.
- NO_MATCH : sujet différent, ou la réponse ne permet pas de trancher ce cas.

Sois STRICT : au moindre doute sur un paramètre décisif, choisis MATCH_PROCHE, jamais MATCH_EXACT.
Tu ne juges pas la halakha elle-même, uniquement la correspondance des cas.`;

async function jugerCorrespondance(nouvelleQuestion, candidat, opts = {}) {
    const apiKey = opts.apiKey || process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY manquant pour le juge Psak Net');

    const body = {
        model: opts.model || CONFIG.JUDGE_MODEL,
        max_tokens: 500,
        system: JUDGE_SYSTEM,
        output_config: { format: { type: 'json_schema', schema: JUDGE_SCHEMA } },
        messages: [{
            role: 'user',
            content: `NOUVELLE QUESTION :\n${nouvelleQuestion}\n\n` +
                `QUESTION DÉJÀ POSÉE AU RAV :\n${candidat.question || '(question d\'origine indisponible)'}\n\n` +
                `RÉPONSE DU RAV (transcription validée) :\n${candidat.answer}`,
        }],
    };

    const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
        },
        body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Juge Psak Net HTTP ${res.status}: ${await res.text()}`);

    const data = await res.json();
    if (data.stop_reason === 'refusal') return { verdict: 'NO_MATCH', raison: 'Refus du juge' };
    const textBlock = (data.content || []).find(b => b.type === 'text');
    return JSON.parse(textBlock.text); // json_schema garantit la forme
}

// =============================================================================
// DÉCISION PRINCIPALE
// =============================================================================

/**
 * @param {string} question - la nouvelle question de l'utilisateur
 * @param {Array} candidats - résultats de recherche, triés par score décroissant :
 *   { id, score (0-1, similarité question<->question), question, answer, audioUrl,
 *     linkMethod ('reply'|...), linkConfidence (0-1) }
 * @param {Object} opts - { searchHealthy: boolean, apiKey, model, judge (injectable pour tests) }
 * @returns {Promise<{verdict, source, judge, raison}>}
 */
async function deciderVerdict(question, candidats, opts = {}) {
    // Système dégradé (Qdrant down...) → abstention explicite, jamais de réponse au rabais
    if (opts.searchHealthy === false) {
        return { verdict: VERDICT.SYSTEME_DEGRADE, source: null, judge: null, raison: 'Recherche sémantique indisponible' };
    }

    const juger = opts.judge || jugerCorrespondance;
    const audessusProche = (candidats || []).filter(c => (c.score || 0) >= CONFIG.SEUIL_PROCHE);
    if (audessusProche.length === 0) {
        return { verdict: VERDICT.AUCUNE_SOURCE, source: null, judge: null, raison: 'Aucun candidat au-dessus du seuil' };
    }

    let meilleurProche = null; // meilleur candidat pour un éventuel verdict B

    for (const c of audessusProche.slice(0, CONFIG.MAX_CANDIDATS_JUGES)) {
        const classe = classerCandidat(c);
        if (classe === 'inutilisable') continue;

        const j = await juger(question, c, opts);

        if (j.verdict === 'MATCH_EXACT'
            && classe === 'citable'
            && c.score >= CONFIG.SEUIL_PSAK_CONFIRME) {
            return { verdict: VERDICT.PSAK_CONFIRME, source: c, judge: j, raison: 'Match exact prouvé' };
        }
        // MATCH_EXACT sans lien prouvé ou sous 0.90, ou MATCH_PROCHE → candidat pour B
        if (j.verdict !== 'NO_MATCH' && !meilleurProche) {
            meilleurProche = { source: c, judge: j };
        }
    }

    if (meilleurProche) {
        return { verdict: VERDICT.QUESTION_PROCHE, ...meilleurProche, raison: 'Correspondance proche, pas identique' };
    }
    return { verdict: VERDICT.AUCUNE_SOURCE, source: null, judge: null, raison: 'Candidats rejetés par le juge' };
}

// =============================================================================
// FORMATAGE — un texte NET par verdict, sans conditionnel flou
// =============================================================================

function formaterDate(ts) {
    if (!ts) return '';
    const d = new Date(ts > 1e12 ? ts : ts * 1000);
    return d.toLocaleDateString('fr-FR');
}

function formaterReponse(resultat) {
    const { verdict, source } = resultat;

    if (verdict === VERDICT.PSAK_CONFIRME) {
        const date = formaterDate(source.timestamp);
        return `✅ *Le Rav a déjà répondu à cette question.*\n\n` +
            `📖 *Psak du Rav :*\n${source.answer.trim()}\n\n` +
            (source.audioUrl ? `🎧 Écouter la réponse du Rav : ${source.audioUrl}\n` : '') +
            `📅 Question d'origine${date ? ` (${date})` : ''} : "${(source.question || '').trim()}"`;
    }

    if (verdict === VERDICT.QUESTION_PROCHE) {
        return `🟡 *Je n'ai pas trouvé cette question exacte, mais le Rav a répondu à une question proche :*\n\n` +
            `❓ Question posée à l'époque : "${(source.question || '').trim()}"\n` +
            `📖 Réponse du Rav dans CE cas-là :\n${source.answer.trim()}\n` +
            (source.audioUrl ? `🎧 Audio : ${source.audioUrl}\n` : '') +
            `\n⚠️ Votre cas n'est pas identique — posez votre question au Rav pour un psak sur votre situation.`;
    }

    if (verdict === VERDICT.SYSTEME_DEGRADE) {
        return `⚙️ Le service de recherche est momentanément indisponible. ` +
            `Pour ne prendre aucun risque, posez votre question directement au Rav dans le groupe.`;
    }

    // VERDICT.AUCUNE_SOURCE
    return `⛔ *Le Rav n'a pas encore répondu à cette question dans nos archives.*\n` +
        `Posez-la directement au Rav dans le groupe.`;
}

module.exports = { CONFIG, VERDICT, deciderVerdict, formaterReponse, jugerCorrespondance, classerCandidat };
