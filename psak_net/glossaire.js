/**
 * Moteur de correction terminologique (hébreu/Torah/Halakha).
 *
 * Charge psak_net/glossaire_termes.json (source de vérité unique) et applique
 * les remplacements de façon SÛRE :
 *   - bornés aux mots (lookarounds Unicode : accents et apostrophes gérés) ;
 *   - anti-cascade par sentinelles en caractères de contrôle (le bug Pessa'h'h
 *     est impossible : les canoniques insérés sont invisibles aux règles suivantes) ;
 *   - variantes les plus longues d'abord (« choulhan aroukh » avant « choulhan ») ;
 *   - casse préservée (majuscule de début de phrase) sauf majuscule forcée ;
 *   - un remplacement qui produirait un texte identique n'est pas compté.
 *
 * Exports :
 *   corrigerTexte(texte)      → { texte, changements: [{avant, apres}] }
 *   normaliserRequete(texte)  → texte corrigé (pour le chemin de recherche)
 */

const fs = require('fs');
const path = require('path');

const S1 = String.fromCharCode(1); // sentinelles : jamais présentes dans du texte réel
const S2 = String.fromCharCode(2);

function chargerRegles(fichier) {
    const gloss = JSON.parse(fs.readFileSync(
        fichier || path.join(__dirname, 'glossaire_termes.json'), 'utf8'));

    const regles = [];
    for (const t of gloss.termes) {
        for (const v of t.variantes) {
            // Ne pas créer de règle si la variante EST la forme canonique (même casse gérée à l'application)
            regles.push({ variante: v, canonique: t.canonique, majuscule: Boolean(t.majuscule) });
        }
    }
    // Les plus longues d'abord pour éviter les recouvrements partiels
    regles.sort((a, b) => b.variante.length - a.variante.length);

    // Compilation : bornes de mots Unicode (lettres/chiffres), insensible à la casse
    const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    for (const r of regles) {
        r.regex = new RegExp(`(?<![\\p{L}\\p{N}])${esc(r.variante)}(?![\\p{L}\\p{N}])`, 'giu');
    }
    return regles;
}

let REGLES = null;
function getRegles() {
    if (!REGLES) REGLES = chargerRegles();
    return REGLES;
}

function appliquerCasse(canonique, matchOriginal, majusculeForcee) {
    if (majusculeForcee) return canonique;
    const premiere = matchOriginal.charAt(0);
    if (premiere === premiere.toUpperCase() && premiere !== premiere.toLowerCase()) {
        return canonique.charAt(0).toUpperCase() + canonique.slice(1);
    }
    return canonique.charAt(0).toLowerCase() + canonique.slice(1);
}

function corrigerTexte(texte, regles) {
    if (!texte) return { texte, changements: [] };
    regles = regles || getRegles();

    const stock = [];      // valeurs finales, protégées par sentinelles
    const changements = [];
    let out = texte;

    for (const r of regles) {
        out = out.replace(r.regex, (m) => {
            const remplacement = appliquerCasse(r.canonique, m, r.majuscule);
            if (remplacement === m) return m; // déjà canonique → intouché, non compté
            changements.push({ avant: m, apres: remplacement });
            stock.push(remplacement);
            return `${S1}${stock.length - 1}${S2}`;
        });
    }

    // Expansion des sentinelles
    out = out.replace(new RegExp(`${S1}(\\d+)${S2}`, 'g'), (_, i) => stock[Number(i)]);
    return { texte: out, changements };
}

/** Normalisation d'une requête utilisateur avant recherche (FTS + embedding). */
function normaliserRequete(texte) {
    return corrigerTexte(texte).texte;
}

module.exports = { chargerRegles, corrigerTexte, normaliserRequete };
