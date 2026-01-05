// enrich_torah.js — structure + réécriture Torah + vérification halakhique
require('dotenv').config();
const OpenAI = require('openai');
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * Enrichit une transcription:
 * 1) extraction structurée (question halakhique + contexte)
 * 2) réécriture "langage du Rav" avec renvois
 * 3) double-contrôle: cohérence + limites (marqueurs de doute, divergences)
 *
 * Retourne un objet:
 * {
 *   question_formalisee, contexte, hypotheses, mots_cles,
 *   torah_style, sources: [{ref, note}], coherence: {ok, avertissements[], divergences[]}
 * }
 */
async function enrichTorah(transcriptionFr) {
  if (!transcriptionFr || !transcriptionFr.trim()) {
    return null;
  }

  // 1) Extraction structurée
  const step1 = await client.chat.completions.create({
    model: process.env.MODEL_GPT || 'gpt-4o',
    temperature: 0.1,
    response_format: { type: "json_object" },
    messages: [
      { role: 'system', content:
        "Tu es un to'en halakhti méticuleux. Tu extrais la question halakhique clairement, sans psak, en notant contexte et hypothèses. Réponds en JSON." },
      { role: 'user', content:
        `Transcription (FR): """${transcriptionFr}"""` }
    ]
  });

  let extracted;
  try {
    extracted = JSON.parse(step1.choices[0].message.content);
  } catch {
    extracted = {};
  }
  // Valeurs par défaut
  const question_formalisee = extracted.question_formalisee || "";
  const contexte = extracted.contexte || "";
  const hypotheses = extracted.hypotheses || [];
  const mots_cles = extracted.mots_cles || [];

  // 2) Réécriture avec ancrage: style Rav + renvois (ne pas inventer; rester général si doute)
  const step2 = await client.chat.completions.create({
    model: process.env.MODEL_GPT || 'gpt-4o',
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages: [
      { role: 'system', content:
        "Tu écris dans un langage clair, respectueux, 'derekh eretz', fidèle aux sources. Tu ne rends pas de psak personnel. " +
        "Tu proposes un exposé structuré + renvois génériques (ex: Choul'han Aroukh YD 95, Michna Broura 170:xx), sans inventer de numéros précis si tu n'es pas sûr. Réponds en JSON."},
      { role: 'user', content: JSON.stringify({
          question_formalisee, contexte, hypotheses, mots_cles
        })
      }
    ]
  });

  let anchored;
  try {
    anchored = JSON.parse(step2.choices[0].message.content);
  } catch {
    anchored = {};
  }
  const torah_style = anchored.torah_style || ""; // texte final "langage du Rav"
  const sources = Array.isArray(anchored.sources) ? anchored.sources : []; // {ref, note}

  // 3) Vérification de cohérence halakhique (marque drapeaux si besoin)
  const step3 = await client.chat.completions.create({
    model: process.env.MODEL_GPT || 'gpt-4o-mini',
    temperature: 0.1,
    response_format: { type: "json_object" },
    messages: [
      { role: 'system', content:
        "Tu vérifies la cohérence halakhique du texte proposé. Tu ne rends pas de psak. " +
        "Signale: (a) termes impropres, (b) confusions de domaines (Issour Véheter vs Berakhot, etc.), " +
        "(c) divergences d'autorités fréquentes, (d) points à confirmer auprès d'un Rav. Réponds en JSON." },
      { role: 'user', content: JSON.stringify({
          question_formalisee, torah_style, sources
        })
      }
    ]
  });

  let check;
  try {
    check = JSON.parse(step3.choices[0].message.content);
  } catch {
    check = {};
  }
  const coherence = {
    ok: check.ok !== false,
    avertissements: check.avertissements || [],
    divergences: check.divergences || [],
    remarques: check.remarques || []
  };

  return {
    question_formalisee, contexte, hypotheses, mots_cles,
    torah_style, sources,
    coherence
  };
}

module.exports = { enrichTorah };

