/**
 * Intent Router V2 - Classification des intentions de requêtes halakhiques
 * 
 * Ce module classifie les requêtes utilisateur pour router vers la stratégie
 * de recherche optimale (FTS5, Semantic, Hybrid).
 * 
 * DESIGN: Rule-based (pas d'appel OpenAI) pour performance et fiabilité
 */

// =============================================================================
// INTENT TYPES
// =============================================================================

const INTENT = {
    FACTUAL: 'factual',         // "Qu'est-ce que X?" → FTS5 keywords
    CONCEPTUAL: 'conceptual',   // "Pourquoi X?" → Semantic search
    PROCEDURAL: 'procedural',   // "Comment faire X?" → Hybrid (RRF)
    NAVIGATION: 'navigation',   // "Messages récents" → DB query
    CLARIFICATION: 'clarification', // Follow-up question
    UNKNOWN: 'unknown'          // Default → Hybrid
};

// =============================================================================
// PATTERN DEFINITIONS (Français + Hébreu translittéré)
// =============================================================================

// Patterns pour questions factuelles (définitions, dates, règles précises)
const FACTUAL_PATTERNS = [
    /^(qu['']?est[- ]ce que?|c['']?est quoi|définition de?|que signifie)/i,
    /^(quel(le)?s? (est|sont)|combien|quand|où)/i,
    /^(מה זה|מהו|מהי|מתי|איפה|כמה)/,  // Hébreu: Quoi/Quand/Où/Combien
    /\b(définition|signification|sens de)\b/i,
    /\bdéfinir\b/i
];

// Patterns pour questions conceptuelles (pourquoi, raisons, philosophie)
const CONCEPTUAL_PATTERNS = [
    /^(pourquoi|pour quelle raison|comment se fait[- ]il)/i,
    /\b(raison|explication|signification profonde|sens de)\b/i,
    /^(למה|מדוע|לשם מה)/,  // Hébreu: Pourquoi
    /\b(symbolise|représente|signifie spirituellement)\b/i
];

// Patterns pour questions procédurales (comment faire, étapes, pratique)
const PROCEDURAL_PATTERNS = [
    /^(comment|de quelle (manière|façon)|que (dois|doit|faut)[- ]il)/i,
    /\b(procédure|étapes|faire|pratiquer|accomplir)\b/i,
    /^(איך|כיצד|באיזה אופן)/,  // Hébreu: Comment
    /\b(mode d['']?emploi|marche à suivre)\b/i,
    /\b(permis|interdit|autorisé|défendu|mouktsé|muktze)\b/i,
    /\b(bénédiction|berakha|netilat|hamotsi)\b/i
];

// Patterns pour navigation (pas une vraie question halakhique)
const NAVIGATION_PATTERNS = [
    /^(montrer?|afficher?|voir?|liste)/i,
    /\b(récent|dernier|historique|tous les)\b/i,
    /\b(messages?|questions?|réponses?) (du|de la|des)\b/i
];

// =============================================================================
// HALAKHIC DOMAIN KEYWORDS (Expanded from guardrails.js)
// =============================================================================

const HALAKHIC_KEYWORDS_EXPANDED = {
    // Shabbat & Fêtes
    shabbat: ['shabbat', 'chabbat', 'shabbos', 'שבת', 'shabbes'],
    yomTov: ['yom tov', 'יום טוב', 'fête', 'hag'],
    pessah: ['pessah', 'pesach', 'pâque', 'פסח', 'matsa', 'hamets', 'חמץ'],
    souccot: ['souccot', 'soukot', 'succos', 'סוכות', 'loulav', 'etrog'],
    pourim: ['pourim', 'purim', 'פורים', 'meguilat esther'],
    hanoucca: ['hanoucca', 'hanouka', 'chanuka', 'חנוכה', 'menora'],
    roshHashana: ['rosh hashana', 'ראש השנה', 'shofar', 'שופר'],
    yomKippour: ['yom kippour', 'kippour', 'יום כיפור', 'jeûne'],
    chavouot: ['chavouot', 'shavuot', 'שבועות', 'tikoun'],

    // Kashrout
    kashrout: ['kasher', 'casher', 'cachère', 'כשר', 'treif', 'טרף'],
    bassarHalav: ['bassar', 'halavi', 'viande', 'lait', 'בשר', 'חלב', 'parve', 'פרווה'],
    ustensiles: ['ustensile', 'four', 'évier', 'plaque', 'casserole', 'tremper', 'טבילה'],

    // Prière
    tefila: ['tefila', 'prière', 'תפילה', 'davening'],
    brachot: ['berakha', 'bénédiction', 'ברכה', 'birkat'],
    minyan: ['minyan', 'מניין', 'kaddish', 'קדיש'],
    amida: ['amida', 'עמידה', 'shemone esre'],
    shema: ['shema', 'chema', 'shma', 'שמע'],

    // Famille & Pureté
    nida: ['nida', 'נידה', 'mikvé', 'mikve', 'מקווה'],
    mariage: ['mariage', 'kiddouchin', 'קידושין', 'ketuba', 'כתובה', 'hatan', 'חתן'],
    divorce: ['guett', 'get', 'גט', 'divorce'],
    deuil: ['deuil', 'avelout', 'אבלות', 'shiva', 'שבעה', 'kria', 'קריעה'],
    naissance: ['brit mila', 'circoncision', 'ברית מילה', 'mohel', 'pidyon'],

    // Torah & Étude
    torah: ['torah', 'תורה', 'paracha', 'parshat'],
    talmud: ['talmud', 'תלמוד', 'guemara', 'גמרא', 'mishna', 'משנה'],
    halakha: ['halakha', 'halacha', 'הלכה', 'din', 'דין'],
    poskim: ['choulhan aroukh', 'שולחן ערוך', 'rambam', 'רמב"ם', 'mishna beroura'],

    // Actions quotidiennes
    netilat: ['netilat', 'נטילת', 'laver mains'],
    tefilin: ['tefiline', 'tefillin', 'תפילין'],
    tsitsit: ['tsitsit', 'tzitzit', 'ציצית'],
    mezouza: ['mezouza', 'mézouza', 'מזוזה'],

    // Termes techniques fréquents
    interdit: ['assour', 'אסור', 'interdit', 'défendu'],
    permis: ['moutar', 'מותר', 'permis', 'autorisé'],
    obligation: ['hova', 'חובה', 'obligatoire', 'mitsva', 'מצווה'],
    muktze: ['mouktsé', 'muktze', 'muktzeh', 'מוקצה']
};

// Flatten for quick lookup
const ALL_HALAKHIC_TERMS = Object.values(HALAKHIC_KEYWORDS_EXPANDED)
    .flat()
    .map(t => t.toLowerCase());

// =============================================================================
// INTENT CLASSIFIER
// =============================================================================

/**
 * Classifie l'intention de la requête utilisateur
 * @param {string} query - La requête brute de l'utilisateur
 * @returns {Object} { intent, confidence, halakhicScore, suggestedStrategy }
 */
function classifyIntent(query) {
    const normalized = (query || '').trim().toLowerCase();

    const result = {
        intent: INTENT.UNKNOWN,
        confidence: 0.5,
        halakhicScore: 0,
        rawQuery: query,
        normalizedQuery: normalized,
        detectedTerms: [],
        suggestedStrategy: 'hybrid' // Default
    };

    if (!normalized || normalized.length < 3) {
        result.intent = INTENT.UNKNOWN;
        result.confidence = 0;
        return result;
    }

    // ===================
    // 1. Check Navigation first (not halakhic)
    // ===================
    if (matchesPatterns(normalized, NAVIGATION_PATTERNS)) {
        result.intent = INTENT.NAVIGATION;
        result.confidence = 0.9;
        result.suggestedStrategy = 'database';
        return result;
    }

    // ===================
    // 2. Detect Halakhic Terms
    // ===================
    const detectedTerms = detectHalakhicTerms(normalized);
    result.detectedTerms = detectedTerms;
    result.halakhicScore = Math.min(1.0, detectedTerms.length * 0.25);

    // ===================
    // 3. Pattern-based Intent Classification
    // ===================

    // Check PROCEDURAL first (most common in halakha)
    if (matchesPatterns(normalized, PROCEDURAL_PATTERNS)) {
        result.intent = INTENT.PROCEDURAL;
        result.confidence = 0.85;
        result.suggestedStrategy = 'hybrid';
    }
    // Then FACTUAL
    else if (matchesPatterns(normalized, FACTUAL_PATTERNS)) {
        result.intent = INTENT.FACTUAL;
        result.confidence = 0.8;
        result.suggestedStrategy = 'fts5';
    }
    // Then CONCEPTUAL
    else if (matchesPatterns(normalized, CONCEPTUAL_PATTERNS)) {
        result.intent = INTENT.CONCEPTUAL;
        result.confidence = 0.8;
        result.suggestedStrategy = 'semantic';
    }
    // Default to UNKNOWN but use hybrid
    else {
        result.intent = INTENT.UNKNOWN;
        result.confidence = 0.5;
        result.suggestedStrategy = 'hybrid';
    }

    // ===================
    // 4. Boost confidence if halakhic terms detected
    // ===================
    if (result.halakhicScore > 0) {
        result.confidence = Math.min(0.95, result.confidence + result.halakhicScore * 0.1);
    }

    return result;
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Check if query matches any pattern in the list
 */
function matchesPatterns(query, patterns) {
    return patterns.some(pattern => pattern.test(query));
}

/**
 * Detect halakhic terms in the query
 */
function detectHalakhicTerms(query) {
    const found = [];
    for (const term of ALL_HALAKHIC_TERMS) {
        if (query.includes(term)) {
            found.push(term);
        }
    }
    return [...new Set(found)]; // Dedupe
}

/**
 * Extract Hebrew terms for query expansion
 */
function extractHebrewTerms(query) {
    const hebrewPattern = /[\u0590-\u05FF]+/g;
    return (query.match(hebrewPattern) || []);
}

/**
 * Suggest query expansions based on detected terms
 */
function suggestExpansions(query, detectedTerms) {
    const expansions = [];

    // For each detected category, add related terms
    for (const [category, terms] of Object.entries(HALAKHIC_KEYWORDS_EXPANDED)) {
        for (const term of detectedTerms) {
            if (terms.includes(term)) {
                // Add other terms from same category
                expansions.push(...terms.filter(t => t !== term).slice(0, 2));
            }
        }
    }

    return [...new Set(expansions)].slice(0, 5);
}

// =============================================================================
// EXPORTS
// =============================================================================

module.exports = {
    INTENT,
    classifyIntent,
    detectHalakhicTerms,
    extractHebrewTerms,
    suggestExpansions,
    HALAKHIC_KEYWORDS_EXPANDED
};
