const OpenAI = require('openai');
require('dotenv').config();

const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

// 1) Correction de la transcription brute
async function cleanTranscription(rawTranscription) {
    const systemPrompt = `
Tu es un assistant chargé de corriger des transcriptions audio de réponses de rabbanim en français.

RÈGLES :
- Corrige UNIQUEMENT : orthographe, grammaire, ponctuation, mots mal reconnus.
- Ne modifie PAS la halakha, ni le sens, ni l’ordre des idées.
- N’ajoute AUCUNE phrase nouvelle.
- Si un passage est incompréhensible ou semble inventé, remplace-le par :
  [PASSAGE INCOMPRÉHENSIBLE À VÉRIFIER SUR L'AUDIO].
- Ne cite AUCUN livre, aucune source, aucun nom qui n’apparaît pas déjà dans le texte.
- Réponds UNIQUEMENT par le texte corrigé, sans commentaire.
`;

    try {
        const completion = await client.chat.completions.create({
            model: process.env.MODEL_GPT || "gpt-4o-mini", // Fallback to 4o-mini if not set
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: rawTranscription || "" },
            ],
            temperature: 0.1,
            max_tokens: 1500, // Increased slightly for safety
        });

        return (completion.choices[0].message.content || "").trim();
    } catch (error) {
        console.error("Error in cleanTranscription:", error);
        return rawTranscription; // Fallback
    }
}

// 2) Génération de la Version "Torah"
async function buildTorahVersion(question, cleanedTranscription) {
    const systemPrompt = `
Tu es chargé de rédiger une Version « Torah » courte, claire et fidèle,
à partir de la transcription corrigée d’un Rav.

RÈGLES :
- Tu te bases UNIQUEMENT sur la transcription corrigée fournie.
- Tu n’ajoutes AUCUNE nouvelle halakha, aucune nouvelle histoire, aucune source qui n’est pas mentionnée dans le texte.
- Style : français simple, respectueux, 3 à 6 phrases maximum.
- Si la transcription contient [PASSAGE INCOMPRÉHENSIBLE À VÉRIFIER SUR L'AUDIO]
  ou est trop floue pour être certaine, écris seulement :
  « La réponse exacte nécessite de vérifier l’audio auprès du Rav, cette transcription n’est pas suffisante pour trancher. »
  puis :
  « En cas de doute pratique, il faut vérifier avec son Rav. »
- Tu n’inventes jamais de noms de livres, dates, lieux ou acronymes.
- Quand c’est possible, termine par :
  « En cas de doute pratique, il faut vérifier avec son Rav. »
- Tu réponds UNIQUEMENT par la Version « Torah », sans explications de ta méthode.
`;

    const userContent = `Question :
${question || "Question non disponible"}

Transcription corrigée :
${cleanedTranscription}
`;

    try {
        const completion = await client.chat.completions.create({
            model: process.env.MODEL_GPT || "gpt-4o-mini",
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: userContent },
            ],
            temperature: 0.2,
            max_tokens: 500,
        });

        return (completion.choices[0].message.content || "").trim();
    } catch (error) {
        console.error("Error in buildTorahVersion:", error);
        return ""; // Fallback
    }
}

// 3) Fonction utilitaire unique
async function processEntry(params) {
    const { question, rawTranscription } = params;

    // Clean
    const transcriptionCorrigee = await cleanTranscription(rawTranscription);

    // Flag
    const hasIncomplete = transcriptionCorrigee.includes(
        "[PASSAGE INCOMPRÉHENSIBLE À VÉRIFIER SUR L'AUDIO]"
    );

    // Torah Version
    const versionTorah = await buildTorahVersion(
        question,
        transcriptionCorrigee
    );

    return {
        transcriptionCorrigee,
        versionTorah,
        drapeauIncomplet: hasIncomplete,
    };
}

module.exports = {
    cleanTranscription,
    buildTorahVersion,
    processEntry
};
