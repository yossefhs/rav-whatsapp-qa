// ===============
// Gestion centralisée des groupes ciblés (hommes / femmes / autres)
// ===============
//
// Historiquement la liste des groupes était codée en dur sur 2 emplacements
// (GROUP_1, GROUP_2) avec une correspondance de nom EXACTE, dupliquée dans
// bot.js et message_processor.js. Résultat : si le nom d'un groupe (ex: le
// groupe des hommes) ne correspondait pas au caractère près (espace en trop,
// casse, emoji, caractère invisible), il était ignoré silencieusement.
//
// Ce module :
//   - supporte un nombre illimité de groupes : GROUP_1..GROUP_N + une variable
//     GROUPS / WHATSAPP_GROUPS séparée par des virgules
//   - applique une correspondance TOLÉRANTE (trim, casse, espaces multiples,
//     caractères invisibles)
//   - expose des logs de diagnostic pour repérer un nom mal configuré

// Combien d'emplacements GROUP_n on scanne au maximum.
const MAX_GROUP_SLOTS = 50;

/**
 * Normalise un nom de groupe pour une comparaison robuste.
 * - supprime les caractères invisibles (LRM/RLM/zero-width) fréquents en hébreu
 * - réduit les espaces multiples
 * - trim + minuscule
 */
function normalizeGroupName(name) {
  if (name == null) return '';
  return String(name)
    .replace(/[​-‏‪-‮⁦-⁩﻿]/g, '') // zero-width / marques directionnelles
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Liste brute des noms de groupes configurés (tels qu'écrits dans l'env).
 * Combine GROUP_1..GROUP_N et GROUPS / WHATSAPP_GROUPS (séparés par des virgules).
 */
function getConfiguredGroups() {
  const names = [];

  // GROUP_1, GROUP_2, ... GROUP_N (les trous sont autorisés)
  for (let i = 1; i <= MAX_GROUP_SLOTS; i++) {
    const v = process.env[`GROUP_${i}`];
    if (v && v.trim()) names.push(v.trim());
  }

  // Liste séparée par des virgules (plus pratique pour ajouter plusieurs groupes)
  const csv = process.env.GROUPS || process.env.WHATSAPP_GROUPS;
  if (csv && csv.trim()) {
    for (const part of csv.split(',')) {
      if (part && part.trim()) names.push(part.trim());
    }
  }

  // Dédoublonnage en gardant la première graphie rencontrée
  const seen = new Set();
  const unique = [];
  for (const n of names) {
    const key = normalizeGroupName(n);
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(n);
    }
  }
  return unique;
}

// Cache des avertissements déjà émis pour ne pas spammer les logs.
const warnedUnmatched = new Set();

/**
 * Retourne true si le chat fait partie des groupes ciblés.
 *
 * Si AUCUN groupe n'est configuré, on renvoie true (comportement historique :
 * on traite alors tous les groupes plutôt que de tout bloquer).
 *
 * @param {string} chatName  Nom du groupe WhatsApp (chat.name)
 * @param {object} [opts]
 * @param {boolean} [opts.warn=false]  Logge un avertissement si un groupe est ignoré (une fois par nom)
 */
function isTargetGroup(chatName, { warn = false } = {}) {
  const configured = getConfiguredGroups();
  if (configured.length === 0) return true; // aucune restriction configurée

  const target = normalizeGroupName(chatName);
  const matched = configured.some((g) => normalizeGroupName(g) === target);

  if (!matched && warn && chatName) {
    const key = normalizeGroupName(chatName);
    if (!warnedUnmatched.has(key)) {
      warnedUnmatched.add(key);
      console.log(
        `⏭️ Groupe ignoré (non configuré) : "${chatName}". ` +
        `Groupes configurés : [${configured.map((g) => `"${g}"`).join(', ')}]`
      );
    }
  }

  return matched;
}

/**
 * Logge une fois la liste des groupes configurés (diagnostic au démarrage).
 */
function logConfiguredGroups() {
  const configured = getConfiguredGroups();
  if (configured.length === 0) {
    console.log('🟡 Aucun groupe configuré (GROUP_1.., GROUPS) → tous les groupes seront traités.');
  } else {
    console.log(`🎯 Groupes ciblés (${configured.length}) : ${configured.map((g) => `"${g}"`).join(', ')}`);
  }
}

module.exports = {
  normalizeGroupName,
  getConfiguredGroups,
  isTargetGroup,
  logConfiguredGroups,
  MAX_GROUP_SLOTS,
};
