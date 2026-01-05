/**
 * Guardrails Module - Phase 6
 * Système de garde-fous pour le RAG halakhique
 */

// =============================================================================
// 1. FILTRE D'ENTRÉE (QUERY VALIDATION)
// =============================================================================

const HALAKHIC_KEYWORDS = [
    // Fêtes
    'shabbat', 'chabbat', 'shabbos', 'yom tov', 'pessah', 'pâque', 'souccot', 'pourim',
    'hanoucca', 'hanoukka', 'rosh hashana', 'yom kippour', 'chavouot', 'tichri',

    // Kashrout
    'casher', 'kasher', 'cachère', 'treif', 'halavi', 'bassar', 'parve', 'viande', 'lait',
    'kashrout', 'cacherout', 'évier', 'ustensile', 'four', 'plaque',

    // Prière
    'tefila', 'prière', 'chema', 'shema', 'amida', 'birkat', 'berakha', 'bénédiction',
    'minyan', 'kaddish', 'hallel', 'minha', 'arvit', 'shaharit',

    // Famille
    'nida', 'mikvé', 'mikve', 'mariage', 'kiddouchin', 'ketuba', 'guett', 'divorce',
    'deuil', 'avelout', 'shiva', 'kria', 'naissance', 'brit mila', 'circoncision',

    // Torah
    'torah', 'talmud', 'halakha', 'halacha', 'mitsvot', 'mitsva', 'interdit', 'permis',
    'rav', 'rabbin', 'choulhan', 'aruch', 'rambam', 'choul\'han aroukh',

    // Actions quotidiennes
    'bénir', 'laver', 'manger', 'cuire', 'allumer', 'bougie', 'lumière', 'travail',
    'netilat', 'hamotsi', 'mezouza', 'tefiline', 'tsitsit', 'kippa'
];

const SPAM_PATTERNS = [
    /^.{0,4}$/,                    // Trop court
    /^[\s\d\W]+$/,                 // Que des espaces/chiffres/symboles
    /select\s+.*\s+from/i,          // SQL injection
    /<script/i,                     // XSS
    /javascript:/i,                 // XSS
    /(\w)\1{4,}/,                   // Caractère répété 5+ fois
    /^(test|hello|hi|salut|bonjour)[\s!?]*$/i  // Messages génériques seuls
];

/**
 * Filtre les requêtes entrantes
 */
function filterQuery(query) {
    const result = {
        valid: true,
        cleaned: '',
        confidence: 1.0,
        reason: null,
        isHalakhic: false
    };

    // Nettoyage
    let cleaned = (query || '').trim()
        .replace(/\s+/g, ' ')
        .toLowerCase();

    // Vérification longueur
    if (cleaned.length < 5) {
        result.valid = false;
        result.reason = 'Question trop courte (minimum 5 caractères)';
        result.confidence = 0;
        return result;
    }

    // Vérification spam/injection
    for (const pattern of SPAM_PATTERNS) {
        if (pattern.test(query)) {
            result.valid = false;
            result.reason = 'Requête détectée comme spam ou invalide';
            result.confidence = 0;
            return result;
        }
    }

    // Détection thématique halakhique
    result.isHalakhic = HALAKHIC_KEYWORDS.some(kw =>
        cleaned.includes(kw.toLowerCase())
    );

    // Ajuster confiance si pas halakhique
    if (!result.isHalakhic) {
        result.confidence = 0.5;
        result.reason = 'Question peut-être hors-sujet halakhique';
    }

    result.cleaned = cleaned;
    return result;
}

// =============================================================================
// 2. SCORING DE CONFIANCE
// =============================================================================

const WEIGHTS = {
    vectorScore: 0.40,    // Score similarité Qdrant
    thematicScore: 0.25,  // Match catégorie halakhique
    qualityScore: 0.20,   // Qualité réponse (longueur, sources)
    recencyScore: 0.15    // Récence de la réponse
};

/**
 * Calcule le score de confiance multi-critères
 */
function calculateConfidence(result, query) {
    const scores = {
        vector: result.score || 0,
        thematic: 0,
        quality: 0,
        recency: 0
    };

    // Score thématique: correspondance mots-clés
    const queryLower = query.toLowerCase();
    const answerLower = (result.answer || '').toLowerCase();
    const matchedKeywords = HALAKHIC_KEYWORDS.filter(kw =>
        queryLower.includes(kw) && answerLower.includes(kw)
    );
    scores.thematic = Math.min(matchedKeywords.length * 0.2, 1.0);

    // Score qualité
    const answerLength = (result.answer || '').length;
    if (answerLength > 500) scores.quality = 1.0;
    else if (answerLength > 200) scores.quality = 0.8;
    else if (answerLength > 100) scores.quality = 0.6;
    else if (answerLength > 50) scores.quality = 0.4;
    else scores.quality = 0.2;

    // Bonus si audio
    if (result.audio_path) scores.quality = Math.min(scores.quality + 0.1, 1.0);

    // Score récence (basé sur timestamp)
    if (result.timestamp) {
        const ageSeconds = (Date.now() / 1000) - result.timestamp;
        const ageYears = ageSeconds / (365 * 24 * 3600);
        scores.recency = Math.max(0, 1 - ageYears * 0.1); // -10% par an
    } else {
        scores.recency = 0.5;
    }

    // Score final pondéré
    const finalScore = (
        WEIGHTS.vectorScore * scores.vector +
        WEIGHTS.thematicScore * scores.thematic +
        WEIGHTS.qualityScore * scores.quality +
        WEIGHTS.recencyScore * scores.recency
    );

    // Niveau de confiance
    let level = 'low';
    let emoji = '🔴';
    if (finalScore > 0.65) { level = 'high'; emoji = '🟢'; }
    else if (finalScore > 0.45) { level = 'medium'; emoji = '🟡'; }

    return {
        score: parseFloat(finalScore.toFixed(3)),
        level,
        emoji,
        details: scores
    };
}

// =============================================================================
// 3. FILTRE DE SORTIE (RESPONSE VALIDATION)
// =============================================================================

const MIN_RESPONSE_LENGTH = 30;
const MIN_VECTOR_SCORE = 0.35;

/**
 * Valide et filtre la réponse
 */
function filterResponse(result, query) {
    const validation = {
        valid: true,
        shouldShow: true,
        warnings: [],
        confidence: null
    };

    // Vérification score vectoriel minimum
    if (!result.score || result.score < MIN_VECTOR_SCORE) {
        validation.valid = false;
        validation.shouldShow = false;
        validation.warnings.push(`Score trop bas (${(result.score || 0).toFixed(2)} < ${MIN_VECTOR_SCORE})`);
    }

    // Vérification longueur réponse
    const answerLength = (result.answer || '').length;
    if (answerLength < MIN_RESPONSE_LENGTH) {
        validation.warnings.push('Réponse courte, vérifiez l\'audio');
        if (!result.audio_path) {
            validation.shouldShow = false;
        }
    }

    // Calculer confiance
    validation.confidence = calculateConfidence(result, query);

    // Si confiance trop basse, demander validation
    if (validation.confidence.level === 'low') {
        validation.warnings.push('Confiance basse - à valider par un utilisateur');
    }

    return validation;
}

// =============================================================================
// 4. REJET NÉGATIF
// =============================================================================

const REJECTION_MESSAGE = {
    noResults: "Je n'ai pas trouvé de réponse fiable à votre question dans les enseignements du Rav. Veuillez reformuler votre question ou consulter directement un rabbin.",

    lowConfidence: "J'ai trouvé une réponse possible, mais ma confiance est limitée. Voici ce que j'ai trouvé, mais je vous recommande de vérifier auprès d'un rabbin.",

    offTopic: "Votre question ne semble pas concerner un sujet halakhique. Ce système est dédié aux questions de Halakha (loi juive). Veuillez reformuler."
};

/**
 * Détermine si la réponse doit être rejetée
 */
function shouldReject(results, queryFilter) {
    // Aucun résultat
    if (!results || results.length === 0) {
        return { reject: true, message: REJECTION_MESSAGE.noResults };
    }

    // Requête hors-sujet
    if (!queryFilter.isHalakhic && queryFilter.confidence < 0.5) {
        return { reject: true, message: REJECTION_MESSAGE.offTopic };
    }

    // Tous les résultats ont un score trop bas
    const bestScore = Math.max(...results.map(r => r.score || 0));
    if (bestScore < MIN_VECTOR_SCORE) {
        return { reject: true, message: REJECTION_MESSAGE.noResults };
    }

    // Confiance moyenne - avertir mais ne pas rejeter
    if (bestScore < 0.5) {
        return { reject: false, warn: true, message: REJECTION_MESSAGE.lowConfidence };
    }

    return { reject: false };
}

// =============================================================================
// 5. MODULE PRINCIPAL
// =============================================================================

/**
 * Applique tous les garde-fous à une requête RAG
 */
async function applyGuardrails(query, searchResults) {
    // 1. Filtre d'entrée
    const queryValidation = filterQuery(query);
    if (!queryValidation.valid) {
        return {
            success: false,
            results: [],
            message: queryValidation.reason,
            queryValidation
        };
    }

    // 2. Vérification rejet
    const rejection = shouldReject(searchResults, queryValidation);
    if (rejection.reject) {
        return {
            success: false,
            results: [],
            message: rejection.message,
            queryValidation,
            rejection
        };
    }

    // 3. Filtrer et scorer chaque résultat
    const validatedResults = searchResults
        .map(result => {
            const validation = filterResponse(result, query);
            return {
                ...result,
                validation,
                confidence: validation.confidence
            };
        })
        .filter(r => r.validation.shouldShow)
        .sort((a, b) => b.confidence.score - a.confidence.score);

    // 4. Construire la réponse
    return {
        success: true,
        results: validatedResults,
        queryValidation,
        warning: rejection.warn ? rejection.message : null,
        stats: {
            total: searchResults.length,
            validated: validatedResults.length,
            rejected: searchResults.length - validatedResults.length
        }
    };
}

// =============================================================================
// EXPORTS
// =============================================================================

module.exports = {
    filterQuery,
    filterResponse,
    calculateConfidence,
    shouldReject,
    applyGuardrails,
    HALAKHIC_KEYWORDS,
    REJECTION_MESSAGE,
    WEIGHTS
};
