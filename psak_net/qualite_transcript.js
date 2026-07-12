/**
 * Juge de LISIBILITÉ des transcriptions — signale, ne réécrit JAMAIS.
 *
 * Classe un transcript servable en :
 *   'lisible'  — compréhensible, citations cohérentes → servable tel quel
 *   'douteux'  — passages suspects (références possiblement broyées) → à drapeau
 *   'charabia' — segments incompréhensibles / citations détruites → à drapeau + re-transcription
 *
 * Le drapeau posé est EXACTEMENT celui que le filtre transcriptionSaine() du
 * moteur Psak détecte déjà → les lignes drapées sortent du circuit psak sans
 * AUCUN changement du moteur. Réversible (journal), cf. scripts/audit_qualite.js.
 *
 * Le juge évalue UNIQUEMENT la lisibilité — jamais la halakha, jamais le style.
 */

const FLAG = "[PASSAGE INCOMPRÉHENSIBLE À VÉRIFIER SUR L'AUDIO]";

const SYSTEM = `Tu évalues la LISIBILITÉ de transcriptions automatiques de cours de Halakha en français (avec termes hébreux).
Tu ne juges NI la halakha NI le style — uniquement : un lecteur peut-il comprendre ce texte et ses citations ?

Classes :
- "lisible" : texte compréhensible, citations de sources cohérentes (ex: "c'est méfourach dans l'Admour HaZaken, siman 529, sé'if 4").
- "douteux" : globalement compréhensible MAIS un passage ou une référence semble broyé par la transcription.
- "charabia" : segments entiers sans sens ou citations détruites (ex: "c'est mes fourrages dans l'Admorazaken Tafkouf Raftet", "un mystère bourrois connu dans riche").

Sois exigeant : un psak sera CITÉ tel quel à des membres. Au doute entre lisible et douteux → douteux.
Réponds en JSON: {"classe": "lisible"|"douteux"|"charabia", "raison": "…", "passages_suspects": ["…"]}`;

async function jugerQualite(texte, opts = {}) {
    const apiKey = opts.apiKey || process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OPENAI_API_KEY manquant pour le juge qualité');

    const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
            model: opts.model || 'gpt-4o-mini',
            temperature: 0,
            response_format: { type: 'json_object' },
            messages: [
                { role: 'system', content: SYSTEM },
                { role: 'user', content: `TRANSCRIPTION À ÉVALUER :\n${texte.substring(0, 6000)}` },
            ],
        }),
    });
    if (!res.ok) throw new Error(`Juge qualité HTTP ${res.status}: ${await res.text()}`);
    const data = await res.json();
    const out = JSON.parse(data.choices[0].message.content);
    if (!['lisible', 'douteux', 'charabia'].includes(out.classe)) out.classe = 'douteux';
    return out;
}

/** Pose le drapeau en tête du texte servi — signalement pur, texte original intact derrière. */
function poserDrapeau(texteServi) {
    if (texteServi.includes(FLAG)) return texteServi;
    return `${FLAG}\n${texteServi}`;
}

module.exports = { jugerQualite, poserDrapeau, FLAG };
