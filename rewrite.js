require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const fs = require('fs');
const path = require('path');
const OpenAI = require('openai');
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Charger le style primer
function loadStylePrimer() {
  const primerPath = path.join(__dirname, 'style_primer.txt');
  if (fs.existsSync(primerPath)) {
    return fs.readFileSync(primerPath, 'utf8');
  }
  return '';
}

/**
 * Réécrit une transcription brute en style Torah / Rav
 * @param {string} text - texte transcrit
 * @returns {Promise<string>} - texte réécrit
 */
async function rewriteTorahStyle(text) {
  if (!text || !text.trim()) return '';

  try {
    const stylePrimer = loadStylePrimer();
    const systemPrompt = stylePrimer 
      ? `${stylePrimer}\n\nTu es un Rav qui reformule les propos en un langage clair, fluide et respectueux de la Torah, en suivant les règles de style ci-dessus.`
      : "Tu es un Rav qui reformule les propos en un langage clair, fluide et respectueux de la Torah.";

    const resp = await client.chat.completions.create({
      model: process.env.MODEL_GPT || 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: systemPrompt
        },
        {
          role: 'user',
          content: text
        }
      ],
      temperature: 0.3,
      max_tokens: 600
    });

    return resp.choices[0]?.message?.content?.trim() || '';
  } catch (err) {
    console.error('❌ Erreur rewriteTorahStyle:', err);
    return '';
  }
}

module.exports = { rewriteTorahStyle };
