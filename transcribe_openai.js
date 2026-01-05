// transcribe_openai.js — sortie en FR par défaut (traduction si besoin)
require('dotenv').config();
const fs = require('fs');
const OpenAI = require('openai');
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const SLEEP = ms => new Promise(r => setTimeout(r, ms));
const HEBREW_RE = /[\u0590-\u05FF]/; // lettres hébraïques

async function transcribeOnce(filePath, { model = 'gpt-4o-transcribe', language = null, verbose = false } = {}) {
  const opts = {
    file: fs.createReadStream(filePath),
    model,
    response_format: verbose ? 'verbose_json' : 'text',
  };
  if (language) opts.language = language;
  const resp = await client.audio.transcriptions.create(opts);
  if (verbose) return { text: resp.text || '', language: (resp.language || '').toLowerCase() };
  return typeof resp === 'string' ? resp : (resp.text || '');
}

// Traduction → français (préserve les termes halakhiques/translittérés)
async function toFrench(text) {
  if (!text || !text.trim()) return '';
  const resp = await client.chat.completions.create({
    model: process.env.MODEL_GPT || 'gpt-4o-mini',
    temperature: 0.1,
    messages: [
      { role: 'system', content: "Tu es un traducteur fidèle. Traduis en FRANÇAIS, proprement et lisiblement, en conservant les termes halakhiques (translittération si nécessaire). N'ajoute aucun commentaire." },
      { role: 'user', content: text }
    ],
  });
  return resp.choices[0]?.message?.content?.trim() || '';
}

/**
 * Règle métier finale :
 * - On détecte la langue de l'audio (verbose_json).
 * - Sauf instruction contraire (KEEP_HEBREW=1), on RENVOIE toujours du FR :
 *     - si det.lang === 'fr' → on garde tel quel
 *     - sinon → on traduit en FR via GPT
 * - Si la question texte contient de l'hébreu, on transcrit plus volontiers l'hébreu,
 *   mais on TRADUIT ensuite en FR (pour l'affichage), sauf KEEP_HEBREW=1.
 */
async function transcribe(filePath, questionHint = null) {
  const preferHebrew = typeof questionHint === 'string' && HEBREW_RE.test(questionHint);
  const keepHebrew   = process.env.KEEP_HEBREW === '1';

  const tries = [
    { model: 'gpt-4o-transcribe', label: '4o-transcribe' },
    { model: 'whisper-1',         label: 'whisper-1' }
  ];

  for (const { model } of tries) {
    let delay = 1200;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        // 1) Détection auto de la langue
        const det = await transcribeOnce(filePath, { model, language: null, verbose: true });
        let txt = det.text || '';
        const lang = (det.language || '').toLowerCase();

        // 2) Si on préfère l'hébreu pour la transcription brute et que KEEP_HEBREW=1,
        // on peut court-circuiter la traduction (cas rares).
        if (keepHebrew && (lang === 'he' || preferHebrew)) return txt;

        // 3) Par défaut on veut du FR en sortie :
        if (lang === 'fr') {
          return txt; // déjà français
        } else {
          // on force une sortie FR (traduction)
          const fr = await toFrench(txt);
          if (fr) return fr;
          // si la traduction a échoué, retente avec un passage FR direct
          const fr2 = await transcribeOnce(filePath, { model, language: 'fr', verbose: false });
          return fr2 || '';
        }
      } catch (e) {
        const msg = e?.message || String(e);
        if (e?.status === 429 || /rate limit|quota/i.test(msg)) {
          await SLEEP(delay); delay *= 2; continue;
        }
        break; // essaie le modèle suivant
      }
    }
  }
  return '';
}

module.exports = { transcribe, toFrench };