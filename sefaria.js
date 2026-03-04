const axios = require('axios');

const SEFARIA_BASE_URL = 'https://www.sefaria.org/api';

/**
 * Récupère le texte complet d'une référence Sefaria (ex: "Shulchan_Arukh,_Orach_Chayim.271.1")
 * @param {string} ref - La référence Sefaria
 * @returns {Promise<string>} Le texte en hébreu et la traduction si disponible
 */
async function getSefariaText(ref) {
    try {
        console.log(`[Sefaria] Fetching text for ref: ${ref}`);
        const url = `${SEFARIA_BASE_URL}/texts/${encodeURIComponent(ref)}`;
        console.log(`[Sefaria] GET ${url}`);
        const response = await axios.get(url, { timeout: 10000 });
        console.log(`[Sefaria] Text response received for ${ref}`);
        const heText = response.data.he ? (Array.isArray(response.data.he) ? response.data.he.join(' ') : response.data.he) : '';
        const enText = response.data.text ? (Array.isArray(response.data.text) ? response.data.text.join(' ') : response.data.text) : '';
        return `[Sefaria: ${response.data.ref}]\\nText (He): ${heText}\\nText (En): ${enText}`;
    } catch (error) {
        console.error(`[Sefaria] API Error on getSefariaText(${ref}):`, error.message);
        return null;
    }
}

/**
 * Récupère les références Halakhiques liées à un topique (ex: "kiddush")
 * @param {string} slug - Le slug du topic issu de Sefaria
 * @returns {Promise<Array>} Liste des sources majeures pour ce topic
 */
async function getSefariaTopicSources(slug) {
    try {
        const url = `${SEFARIA_BASE_URL}/topics/${encodeURIComponent(slug)}`;
        console.log(`[Sefaria] GET Topic: ${url}`);
        const response = await axios.get(url, { timeout: 10000 }); // Add timeout to prevent hanging
        console.log(`[Sefaria] Topic response received!`);
        const sources = response.data.sources || [];
        console.log(`[Sefaria] Sources length: ${sources.length}`);

        // Sefaria topics API usually returns an array of source objects.
        // We need to safely extract the 'ref' property.
        const refs = sources
            .filter(s => s && s[0] && typeof s[0] === 'string') // Sometimes it's an array of refs
            .map(s => s[0]);

        if (refs.length === 0) {
            console.log(`[Sefaria] No array-based refs found. Checking for object-based refs.`);
            // Alternative format: Array of objects with 'ref' property
            const objRefs = sources
                .filter(s => s && typeof s.ref === 'string')
                .map(s => s.ref);
            if (objRefs.length > 0) {
                console.log(`[Sefaria] Extracted ${objRefs.length} obj refs. Returning top 5.`);
                return objRefs.slice(0, 5);
            }
        }

        console.log(`[Sefaria] Extracted ${refs.length} refs. Returning top 5.`);
        return refs.slice(0, 5);
    } catch (error) {
        console.error(`❌ Sefaria API Error on getSefariaTopicSources(${slug}):`, error.message);
        if (error.response) {
            console.error(`   Status: ${error.response.status}`);
            console.error(`   Data:`, error.response.data);
        }
        return [];
    }
}

module.exports = {
    getSefariaText,
    getSefariaTopicSources
};
