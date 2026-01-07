const admin = require('firebase-admin');
const path = require('path');

/**
 * Firebase Sync Module - Real-time synchronization to Firebase
 * Dual-storage architecture: SQLite (local) + Firebase (web access)
 */
class FirebaseSync {
    constructor() {
        this.initialized = false;
        this.ref = null;
        this.bucket = null;
        this.initializeFirebase();
    }

    initializeFirebase() {
        try {
            // Check if already initialized
            if (admin.apps.length > 0) {
                console.log('✅ Firebase already initialized');
                this.initialized = true;
                this.ref = admin.database().ref('qa_pairs');
                this.bucket = admin.storage().bucket();
                return;
            }

            // Firebase Sync (Optionnel - Désactivé si pas de credentials)
            let firebaseApp = null;
            try {
                // Check if credentials path is provided, otherwise skip Firebase initialization
                const credPath = process.env.FIREBASE_CREDENTIALS_PATH || path.join(__dirname, 'firebase-credentials.json');
                const serviceAccount = require(credPath); // This will throw if file doesn't exist

                firebaseApp = admin.initializeApp({
                    credential: admin.credential.cert(serviceAccount),
                    databaseURL: process.env.FIREBASE_DATABASE_URL,
                    storageBucket: process.env.FIREBASE_STORAGE_BUCKET
                });

                this.ref = admin.database().ref('qa_pairs');
                this.bucket = admin.storage().bucket();
                this.initialized = true;
                console.log('✅ Firebase initialized successfully');

            } catch (credError) {
                // If credentials file is not found or other credential error, log and disable Firebase
                console.log(`⚠️ Firebase initialization skipped: ${credError.message}. Running in SQLite-only mode.`);
                this.initialized = false;
                // No need to re-throw, just proceed without Firebase
            }

        } catch (error) {
            console.error('❌ Firebase initialization failed:', error.message);
            console.log('⚠️  Falling back to SQLite-only mode');
            this.initialized = false;
        }
    }

    /**
     * Format timestamp from Unix seconds to DD/MM/YYYY HH:MM:SS
     */
    formatTimestamp(unixSec) {
        if (!unixSec) return '';
        const d = new Date(unixSec * 1000);
        const pad = (n) => String(n).padStart(2, '0');
        return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    }

    /**
     * Save message to Firebase
     * @param {Object} data - Message data from SQLite
     */
    async saveMessage(data) {
        if (!this.initialized) {
            console.log('⏭️  Firebase not initialized, skipping sync');
            return null;
        }

        try {
            const key = `msg_${data.wa_message_id || Date.now()}`;

            const firebaseData = {
                question: data.question_text || '',
                question_author: data.sender_name || '',
                question_timestamp: this.formatTimestamp(data.ts),
                answer_text: data.transcript_torah || data.transcript_raw || '',
                answer_author: data.answer_sender || 'Le Rav',
                answer_timestamp: this.formatTimestamp(data.ts),
                audio_filename: data.audio_path ? path.basename(data.audio_path) : null,
                audio_url: data.audio_firebase_url || null,
                link_confidence: data.link_confidence || null,
                link_method: data.link_method || null,
                group_name: data.group_name || '',
                source: 'whatsapp_realtime',
                created_at: new Date().toISOString()
            };

            await this.ref.child(key).set(firebaseData);
            console.log('✅ Synced to Firebase:', key);

            return key;
        } catch (error) {
            console.error('❌ Firebase saveMessage error:', error.message);
            // Don't throw - allow SQLite to continue
            return null;
        }
    }

    /**
     * Update question-answer link in Firebase
     * @param {string} answerId - Firebase key of the answer
     * @param {Object} questionData - Question data to link
     */
    async linkQA(answerId, questionData) {
        if (!this.initialized) return null;

        try {
            await this.ref.child(answerId).update({
                question: questionData.text || '',
                question_author: questionData.author || '',
                question_timestamp: this.formatTimestamp(questionData.ts),
                link_confidence: questionData.confidence || null,
                link_method: 'realtime_ai',
                linked_at: new Date().toISOString()
            });

            console.log('✅ Linked Q&A in Firebase:', answerId);
            return true;
        } catch (error) {
            console.error('❌ Firebase linkQA error:', error.message);
            return false;
        }
    }

    /**
     * Upload audio file to Firebase Storage
     * @param {string} localPath - Local file path
     * @param {string} messageId - WhatsApp message ID for naming
     * @returns {string|null} Public URL or null on error
     */
    async uploadAudio(localPath, messageId) {
        if (!this.initialized || !this.bucket) {
            console.log('⏭️  Firebase Storage not available, skipping upload');
            return null;
        }

        try {
            const filename = path.basename(localPath);
            const destination = `media/${filename}`;

            // Upload file
            await this.bucket.upload(localPath, {
                destination: destination,
                metadata: {
                    contentType: 'audio/ogg',
                    metadata: {
                        messageId: messageId,
                        uploadedAt: new Date().toISOString()
                    }
                }
            });

            // Make public
            const file = this.bucket.file(destination);
            await file.makePublic();

            const publicUrl = `https://storage.googleapis.com/${this.bucket.name}/${destination}`;
            console.log('✅ Audio uploaded to Firebase Storage:', filename);

            return publicUrl;
        } catch (error) {
            console.error('❌ Firebase uploadAudio error:', error.message);
            return null;
        }
    }

    /**
     * Batch update multiple entries (useful for bulk operations)
     */
    async batchUpdate(updates) {
        if (!this.initialized) return false;

        try {
            await this.ref.update(updates);
            console.log(`✅ Batch updated ${Object.keys(updates).length} entries`);
            return true;
        } catch (error) {
            console.error('❌ Firebase batchUpdate error:', error.message);
            return false;
        }
    }

    /**
     * Get current sync status
     */
    getStatus() {
        return {
            initialized: this.initialized,
            hasDatabase: !!this.ref,
            hasStorage: !!this.bucket
        };
    }
}

// Singleton instance
const firebaseSync = new FirebaseSync();

module.exports = firebaseSync;
