/**
 * Système de Feedback - Phase 7
 * Collecte et analyse les retours utilisateurs pour amélioration continue
 */

require('dotenv').config();
const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.DB_PATH || './ravqa.db';

// =============================================================================
// SCHEMA FEEDBACK
// =============================================================================

/**
 * Crée la table feedback si elle n'existe pas
 */
function ensureFeedbackTable(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS feedback (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            query TEXT NOT NULL,
            message_id INTEGER,
            is_relevant BOOLEAN,
            rating INTEGER CHECK(rating >= 1 AND rating <= 5),
            comment TEXT,
            user_ip TEXT,
            created_at INTEGER DEFAULT (strftime('%s', 'now')),
            FOREIGN KEY (message_id) REFERENCES messages(id)
        )
    `);

    db.exec(`
        CREATE INDEX IF NOT EXISTS idx_feedback_message ON feedback(message_id);
        CREATE INDEX IF NOT EXISTS idx_feedback_created ON feedback(created_at);
    `);
}

// =============================================================================
// CLASSE FEEDBACK MANAGER
// =============================================================================

class FeedbackManager {
    constructor() {
        this.db = new Database(DB_PATH);
        ensureFeedbackTable(this.db);
    }

    /**
     * Enregistre un feedback utilisateur
     */
    addFeedback({ query, messageId, isRelevant, rating, comment, userIp }) {
        const stmt = this.db.prepare(`
            INSERT INTO feedback (query, message_id, is_relevant, rating, comment, user_ip)
            VALUES (?, ?, ?, ?, ?, ?)
        `);

        const result = stmt.run(query, messageId, isRelevant ? 1 : 0, rating, comment, userIp);

        // Mettre à jour score de pertinence du message si disponible
        if (messageId && isRelevant !== undefined) {
            this.updateMessageRelevance(messageId, isRelevant);
        }

        return result.lastInsertRowid;
    }

    /**
     * Met à jour le score de pertinence d'un message basé sur les feedbacks
     */
    updateMessageRelevance(messageId, isRelevant) {
        // Ajouter colonne si nécessaire
        const cols = this.db.prepare("PRAGMA table_info(messages)").all();
        if (!cols.some(c => c.name === 'relevance_score')) {
            this.db.exec("ALTER TABLE messages ADD COLUMN relevance_score REAL DEFAULT 0.5");
            this.db.exec("ALTER TABLE messages ADD COLUMN feedback_count INTEGER DEFAULT 0");
        }

        // Calculer nouveau score
        const msg = this.db.prepare(`
            SELECT relevance_score, feedback_count FROM messages WHERE id = ?
        `).get(messageId);

        if (msg) {
            const newCount = (msg.feedback_count || 0) + 1;
            const currentScore = msg.relevance_score || 0.5;
            const feedbackValue = isRelevant ? 1 : 0;

            // Moyenne pondérée mobile
            const newScore = (currentScore * (msg.feedback_count || 0) + feedbackValue) / newCount;

            this.db.prepare(`
                UPDATE messages SET relevance_score = ?, feedback_count = ? WHERE id = ?
            `).run(newScore, newCount, messageId);
        }
    }

    /**
     * Récupère les statistiques de feedback
     */
    getStats() {
        const total = this.db.prepare("SELECT COUNT(*) as n FROM feedback").get().n;

        const byRelevance = this.db.prepare(`
            SELECT is_relevant, COUNT(*) as count 
            FROM feedback 
            GROUP BY is_relevant
        `).all();

        const avgRating = this.db.prepare(`
            SELECT AVG(rating) as avg FROM feedback WHERE rating IS NOT NULL
        `).get().avg;

        const recentFeedback = this.db.prepare(`
            SELECT f.*, m.question_text 
            FROM feedback f
            LEFT JOIN messages m ON f.message_id = m.id
            ORDER BY f.created_at DESC
            LIMIT 10
        `).all();

        // Messages avec le plus de feedback négatif
        const problematicMessages = this.db.prepare(`
            SELECT m.id, m.question_text, m.relevance_score, m.feedback_count
            FROM messages m
            WHERE m.feedback_count > 0
            ORDER BY m.relevance_score ASC
            LIMIT 10
        `).all();

        return {
            total,
            relevance: {
                positive: byRelevance.find(r => r.is_relevant === 1)?.count || 0,
                negative: byRelevance.find(r => r.is_relevant === 0)?.count || 0
            },
            averageRating: avgRating ? parseFloat(avgRating.toFixed(2)) : null,
            recentFeedback,
            problematicMessages
        };
    }

    /**
     * Identifie les requêtes sans bons résultats (pour amélioration)
     */
    getUnmetNeeds() {
        return this.db.prepare(`
            SELECT query, COUNT(*) as count
            FROM feedback
            WHERE is_relevant = 0
            GROUP BY query
            ORDER BY count DESC
            LIMIT 20
        `).all();
    }

    close() {
        this.db.close();
    }
}

// =============================================================================
// API ENDPOINTS
// =============================================================================

function setupFeedbackEndpoints(app, invalidateCache) {
    const express = require('express');
    const manager = new FeedbackManager();

    // POST /api/feedback - Soumettre un feedback
    app.post('/api/feedback', express.json(), (req, res) => {
        const { query, messageId, isRelevant, rating, comment } = req.body;

        if (!query && !messageId) {
            return res.status(400).json({ error: 'query ou messageId requis' });
        }

        try {
            const id = manager.addFeedback({
                query,
                messageId,
                isRelevant,
                rating,
                comment,
                userIp: req.ip
            });

            if (invalidateCache) {
                invalidateCache();
                console.log('🧹 Cache invalidé suite au feedback');
            }

            res.json({ ok: true, feedbackId: id });
        } catch (error) {
            console.error('Feedback error:', error);
            res.status(500).json({ error: error.message });
        }
    });

    // GET /api/feedback/stats - Statistiques feedback
    app.get('/api/feedback/stats', (req, res) => {
        try {
            const stats = manager.getStats();
            res.json(stats);
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    // GET /api/feedback/unmet - Besoins non satisfaits
    app.get('/api/feedback/unmet', (req, res) => {
        try {
            const unmet = manager.getUnmetNeeds();
            res.json({ queries: unmet });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    console.log('✅ Feedback endpoints registered: /api/feedback, /api/feedback/stats');
}

// =============================================================================
// EXPORTS
// =============================================================================

module.exports = {
    FeedbackManager,
    setupFeedbackEndpoints,
    ensureFeedbackTable
};

// CLI
if (require.main === module) {
    const manager = new FeedbackManager();
    const stats = manager.getStats();

    console.log('📊 STATISTIQUES FEEDBACK\n');
    console.log(`Total feedbacks: ${stats.total}`);
    console.log(`  👍 Positifs: ${stats.relevance.positive}`);
    console.log(`  👎 Négatifs: ${stats.relevance.negative}`);
    if (stats.averageRating) {
        console.log(`  ⭐ Note moyenne: ${stats.averageRating}/5`);
    }

    if (stats.problematicMessages.length > 0) {
        console.log('\n⚠️ Messages problématiques:');
        stats.problematicMessages.forEach(m => {
            console.log(`  ID ${m.id}: score ${(m.relevance_score * 100).toFixed(0)}% (${m.feedback_count} avis)`);
        });
    }

    manager.close();
}
