/**
 * Qdrant Client V2 - Gestion de la base vectorielle
 * 
 * Module pour interagir avec Qdrant (création collection, upsert, search)
 * Remplace le cache vectoriel en RAM de la V1.
 */

require('dotenv').config();
const axios = require('axios');

const QDRANT_URL = process.env.QDRANT_URL || 'http://localhost:6333';
const COLLECTION_NAME = 'halakhic_qa_v2';
const VECTOR_SIZE = 1536; // OpenAI text-embedding-3-small

/**
 * Client Qdrant minimaliste
 */
class QdrantClient {
    constructor() {
        this.baseUrl = QDRANT_URL;
        this.collection = COLLECTION_NAME;
    }

    /**
     * Vérifie si le serveur Qdrant est accessible
     */
    async healthCheck() {
        try {
            const res = await axios.get(`${this.baseUrl}/collections`);
            return { status: 'ok', collections: res.data.result.collections };
        } catch (error) {
            console.error('❌ Qdrant Connection Error:', error.message);
            return { status: 'error', message: error.message };
        }
    }

    /**
     * Crée la collection si elle n'existe pas
     */
    async ensureCollection() {
        try {
            // Check if exists
            const res = await axios.get(`${this.baseUrl}/collections/${this.collection}`);
            console.log(`✅ Collection '${this.collection}' exists.`);
            return true;
        } catch (error) {
            if (error.response && error.response.status === 404) {
                console.log(`⚠️ Collection '${this.collection}' missing. Creating...`);
                try {
                    await axios.put(`${this.baseUrl}/collections/${this.collection}`, {
                        vectors: {
                            size: VECTOR_SIZE,
                            distance: 'Cosine'
                        }
                    });
                    console.log(`✅ Collection '${this.collection}' created.`);
                    return true;
                } catch (createError) {
                    console.error('❌ Failed to create collection:', createError.message);
                    return false;
                }
            } else {
                console.error('❌ Error checking collection:', error.message);
                return false;
            }
        }
    }

    /**
     * Insère ou met à jour des points (Batch upsert)
     * @param {Array} points - Array of { id, vector, payload }
     */
    async upsertPoints(points) {
        if (!points || points.length === 0) return;

        try {
            const response = await axios.put(`${this.baseUrl}/collections/${this.collection}/points?wait=true`, {
                points: points.map(p => ({
                    id: p.id,
                    vector: p.vector,
                    payload: p.payload
                }))
            });
            return response.data;
        } catch (error) {
            console.error('❌ Upsert error:', error.message);
            throw error;
        }
    }

    /**
     * Recherche vectorielle
     * @param {Array} vector - Query vector
     * @param {number} limit - Max results
     * @param {number} scoreThreshold - Min score
     */
    async search(vector, limit = 10, scoreThreshold = 0.5) {
        try {
            const response = await axios.post(`${this.baseUrl}/collections/${this.collection}/points/search`, {
                vector: vector,
                limit: limit,
                with_payload: true,
                score_threshold: scoreThreshold
            });
            return response.data.result;
        } catch (error) {
            console.error('❌ Search error:', error.message);
            return [];
        }
    }

    /**
     * Count total points
     */
    async count() {
        try {
            const res = await axios.post(`${this.baseUrl}/collections/${this.collection}/points/count`, { exact: true });
            return res.data.result.count;
        } catch (error) {
            return 0;
        }
    }
}

module.exports = { QdrantClient, COLLECTION_NAME };
