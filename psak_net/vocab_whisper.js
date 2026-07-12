/**
 * Construit le prompt de vocabulaire pour Whisper / gpt-4o-transcribe.
 *
 * Whisper accepte un paramètre `prompt` qui biaise sa reconnaissance vers le
 * vocabulaire fourni (limite ~224 tokens — on reste bien en dessous). En lui
 * donnant les termes halakhiques canoniques + les noms de décisionnaires +
 * le vocabulaire des citations, les références sortent justes au lieu de
 * « l'Admorazaken Siman Tafkouf Raftet » ou « un mystère bourrois ».
 *
 * À passer dans transcribe : client.audio.transcriptions.create({ ..., prompt }).
 * Sert pour les NOUVEAUX audios (satellite) ET la re-transcription des charabias.
 */

const fs = require('fs');
const path = require('path');

// Décisionnaires et ouvrages fréquemment cités par le Rav (extensible)
const POSKIM = [
    'Choul\'han Aroukh', 'Michna Beroura', 'Admour HaZaken', 'Kaf Ha\'Haim',
    'Ben Ich \'Haï', 'Rav Ovadia Yossef', 'Yalkout Yossef', 'Halakha Beroura',
    'Rambam', 'Rachi', 'Tossafot', 'Guemara', 'Michna', 'Zohar',
    'Aroukh HaChoul\'han', 'Chemirat Chabbat Kehilkhata', 'Igrot Moché',
];

// Vocabulaire des citations (siman, sé'if, lettres-nombres hébraïques)
const CITATIONS = [
    'siman', 'sé\'if', 'sé\'if katan', 'halakha', 'perek', 'daf',
    'méfourach', 'psak', 'din', 'issour', 'heter', 'le\'hat\'hila', 'bediavad',
    'mi\'dérabanan', 'mi\'deoraïta', 'safek', 'houmra', 'koula',
];

function construirePromptVocab(fichierGlossaire) {
    let canoniques = [];
    try {
        const gloss = JSON.parse(fs.readFileSync(
            fichierGlossaire || path.join(__dirname, 'glossaire_termes.json'), 'utf8'));
        canoniques = gloss.termes.map(t => t.canonique);
    } catch (e) { /* glossaire absent → poskim + citations seuls */ }

    // Une phrase naturelle marche mieux qu'une liste brute pour biaiser Whisper
    const vocab = [...new Set([...POSKIM, ...CITATIONS, ...canoniques])];
    const prompt = `Cours de Halakha en français du Rav Abichid, citant : ${vocab.join(', ')}.`;

    // Garde-fou : rester sous la limite (~224 tokens ≈ ~800 caractères prudents)
    return prompt.length > 800 ? prompt.substring(0, 797) + '…' : prompt;
}

module.exports = { construirePromptVocab, POSKIM, CITATIONS };
