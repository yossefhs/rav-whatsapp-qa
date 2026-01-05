require('dotenv').config();
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const DB = require('./db');
const { transcribe } = require('./transcribe_openai');
const { rewriteTorahStyle } = require('./rewrite');
const { enrichTorah } = require('./enrich_torah');
const { enhancedMatchAnswerToQuestion } = require('./enhanced_matcher');
const { processEntry } = require('./torah_transcription');
const firebaseSync = require('./firebase_sync'); // NOUVEAU: Real-time Firebase sync

const MEDIA_DIR = path.join(__dirname, 'media');
if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR);

// ===============
// Fonctions d'auto-liage question ↔ réponse
// ===============

function findCandidateQuestions(groupName, tsSec, windowHours = 6, limit = 30) {
    const db = new Database(process.env.DB_PATH || path.join(__dirname, 'ravqa.db'));
    // Cherche les questions du même groupe, posées AVANT la réponse, dans une fenêtre temporelle
    return db.prepare(`
    SELECT id, ts, question_text
    FROM messages
    WHERE group_name = ?
      AND question_text IS NOT NULL AND question_text!=''
      AND ts <= ?
      AND ts >= ? - ?
    ORDER BY ts DESC
    LIMIT ?
  `).all(groupName, tsSec, tsSec, windowHours * 3600, limit);
}

function simpleSimilarity(a, b) {
    if (!a || !b) return 0;
    a = a.toLowerCase(); b = b.toLowerCase();
    // petit score heuristique (mots en commun)
    const ta = new Set(a.split(/\W+/).filter(Boolean));
    const tb = new Set(b.split(/\W+/).filter(Boolean));
    let inter = 0; for (const t of ta) if (tb.has(t)) inter++;
    return inter / Math.max(3, Math.min(ta.size, tb.size));
}

function pickBestQuestion(candidates, answerText) {
    let best = null;
    for (const c of candidates) {
        const s = simpleSimilarity(c.question_text, answerText);
        if (!best || s > best.score) best = { id: c.id, score: s };
    }
    return best;
}

async function autoLinkAnswer(waId, groupName, answerText) {
    try {
        const tsSec = Math.floor(Date.now() / 1000);
        const candidates = findCandidateQuestions(groupName, tsSec, 6, 50);

        let linkId = null, conf = null;

        if (candidates.length > 0) {
            const best = pickBestQuestion(candidates, answerText);
            if (best && best.score >= 0.15) { // seuil léger
                linkId = best.id;
                conf = Number(best.score.toFixed(3));
            } else {
                // fallback : la plus proche dans le temps (1ère de la liste)
                linkId = candidates[0].id;
                conf = 0.05;
            }
        }

        // Mise à jour en base
        const db = new Database(process.env.DB_PATH || path.join(__dirname, 'ravqa.db'));
        db.prepare(`
      UPDATE messages
      SET link_question_id = COALESCE(?, link_question_id), 
          link_confidence = COALESCE(?, link_confidence)
      WHERE wa_message_id = ?
    `).run(linkId, conf, waId);

        if (linkId) {
            console.log(`🔗 Auto-liage: ${waId} → question #${linkId} (confiance: ${conf})`);
        }
    } catch (e) {
        console.log('⚠️ Erreur auto-liage:', e?.message || e);
    }
}

// ===============
// Gestionnaire de messages unifié (Live & Catch-up)
// ===============
async function processMessage(msg, { isCatchUp = false } = {}) {
    try {
        const chat = await msg.getChat();

        // Vérifier si c'est un groupe ciblé
        if (!chat.isGroup) return;
        const GROUPS = [process.env.GROUP_1, process.env.GROUP_2].filter(Boolean);
        if (GROUPS.length && !GROUPS.includes(chat.name)) return;

        if (!isCatchUp) {
            console.log(`📥 Message reçu de ${chat.name} (${msg.type})`);
        }

        const tsMs = (msg.timestamp || Math.floor(Date.now() / 1000)) * 1000;
        const waId = msg.id._serialized;
        const senderJid = (msg.author || msg.from || '').toString();
        const senderName = (msg._data?.notifyName) || senderJid.split('@')[0];

        // 1) Texte → mémoriser question
        if (msg.type === 'chat' && msg.body && msg.body.trim()) {
            const questionData = {
                wa_message_id: waId,
                group_name: chat.name,
                sender_name: senderName,
                sender_jid: senderJid,
                ts: Math.floor(tsMs / 1000),
                audio_path: null,
                audio_seconds: null,
                question_text: msg.body.trim(),
                question_message_id: waId,
                transcript_raw: null,
                transcript_torah: null,
                replied_to_message_id: null
            };

            await DB.upsert(questionData);

            // NOUVEAU: Sync to Firebase
            await firebaseSync.saveMessage(questionData).catch(e =>
                console.log('⚠️ Firebase sync failed (question):', e.message)
            );

            if (!isCatchUp) {
                console.log(`📝 Question: ${msg.body.trim().substring(0, 50)}...`);
            }
            return;
        }

        // 2) Audio
        if ((msg.type === 'ptt' || msg.type === 'audio') && msg.hasMedia) {
            const media = await msg.downloadMedia();
            if (!media) return;

            const buffer = Buffer.from(media.data, 'base64');
            const ext =
                media.mimetype.includes('ogg') ? 'ogg' :
                    media.mimetype.includes('opus') ? 'opus' :
                        media.mimetype.includes('mp4') ? 'mp4' : 'mp3';

            const filename = `${waId}.${ext}`;
            const filePath = path.join(MEDIA_DIR, filename);

            // Éviter d'écraser si existe déjà (optimisation catch-up)
            if (!fs.existsSync(filePath) || fs.statSync(filePath).size === 0) {
                fs.writeFileSync(filePath, buffer);
            }

            let repliedToId = null, question_text = null, question_message_id = null;

            // Essayer de trouver le contexte (réponse à quoi ?)
            try {
                if (msg.hasQuotedMsg) {
                    const q = await msg.getQuotedMessage();
                    if (q) {
                        repliedToId = q.id._serialized;
                        if (q.type === 'chat' && q.body && q.body.trim()) {
                            question_text = q.body.trim();
                            question_message_id = q.id._serialized;
                        }
                    }
                }
            } catch (_) { }

            // Si pas de réponse explicite, chercher la dernière question pertinente
            if (!question_message_id) {
                const THRESHOLD_SEC = 30 * 60; // 30 min
                const tAudio = Math.floor(tsMs / 1000);

                // 1. Chercher une question récente du même auteur (auto-réponse ?)
                const sameAuthor = await DB.findRecentQuestionByAuthor(chat.name, senderJid, tAudio, THRESHOLD_SEC);
                if (sameAuthor?.id) {
                    question_message_id = sameAuthor.id;
                    question_text = sameAuthor.question_text;
                } else {
                    // 2. Chercher la dernière question du groupe
                    const lastInGroup = await DB.findRecentQuestionInGroup(chat.name, tAudio, THRESHOLD_SEC);
                    if (lastInGroup?.id) {
                        question_message_id = lastInGroup.id;
                        question_text = lastInGroup.question_text;
                    }
                }
            }

            // Sauvegarde initiale de l'audio
            await DB.upsert({
                wa_message_id: waId,
                group_name: chat.name,
                sender_name: senderName,
                sender_jid: senderJid,
                ts: Math.floor(tsMs / 1000),
                audio_path: filePath,
                audio_seconds: msg._data?.duration || null,
                question_text,
                question_message_id,
                transcript_raw: null,
                transcript_torah: null,
                replied_to_message_id: repliedToId
            });

            // Transcription
            let raw = null;
            // 0) Vérifier cache DB pour éviter de repayer OpenAI Whisper
            const existingEntry = await DB.findByWA(waId);
            if (existingEntry && existingEntry.transcript_raw) {
                raw = existingEntry.transcript_raw;
                if (!isCatchUp) console.log('⚡ Transcription récupérée du cache DB.');
            } else {
                raw = await transcribe(filePath, question_text || null);
            }

            if (!raw) return;

            // Save RAW transcription immediately (if not already there)
            if (!existingEntry || !existingEntry.transcript_raw) {
                await DB.updateTranscript(waId, raw, null);
            }

            // 1) Matching intelligent question↔réponse
            const match = await enhancedMatchAnswerToQuestion({
                groupName: chat.name,
                audioWAId: waId,
                answerText: raw,
                answerSender: senderName || '',
                answerTsSec: Math.floor(tsMs / 1000),
                repliedToMessageId: repliedToId || null,
                questionTextHint: question_text || null
            });

            // 2) NOUVEAU FLUX : Correction + Version Torah (remplace l'ancien enrichissement)
            const { transcriptionCorrigee, versionTorah, drapeauIncomplet } = await processEntry({
                question: question_text || match.questionText || '', // Use matched question text if available
                rawTranscription: raw
            });

            // 3) Mise à jour DB avec les versions traitées
            await DB.updateProcessedEntry(waId, transcriptionCorrigee, versionTorah, drapeauIncomplet);

            // 4) NOUVEAU: Upload audio to Firebase Storage
            let firebaseAudioUrl = null;
            try {
                firebaseAudioUrl = await firebaseSync.uploadAudio(filePath, waId);
                if (firebaseAudioUrl && !isCatchUp) {
                    console.log('☁️ Audio uploaded to Firebase Storage');
                }
            } catch (e) {
                console.log('⚠️ Firebase audio upload failed:', e.message);
            }

            // 5) NOUVEAU: Sync to Firebase with complete data
            const audioData = {
                wa_message_id: waId,
                group_name: chat.name,
                sender_name: senderName,
                sender_jid: senderJid,
                ts: Math.floor(tsMs / 1000),
                audio_path: filePath,
                audio_firebase_url: firebaseAudioUrl,
                audio_seconds: msg._data?.duration || null,
                question_text: match.questionText || question_text,
                transcript_raw: raw,
                transcript_torah: versionTorah,
                link_question_id: match.qid,
                link_confidence: match.confidence,
                link_method: match.method,
                answer_sender: senderName
            };

            await firebaseSync.saveMessage(audioData).catch(e =>
                console.log('⚠️ Firebase sync failed (audio):', e.message)
            );

            // 6) Auto-liage (sur la version Torah générée)
            await autoLinkAnswer(waId, chat.name, versionTorah || raw || '');

            if (!isCatchUp) {
                console.log(`🔗 Lien ${match.method} → qid=${match.qid || 'aucune'} (conf=${(match.confidence || 0).toFixed(2)})`);
                console.log(`🎵 Traité: ${versionTorah.substring(0, 50)}... [Incomplet: ${drapeauIncomplet}]`);
            }
        }

        // 3) Image
        if (msg.type === 'image' && msg.hasMedia) {
            const media = await msg.downloadMedia();
            if (media) {
                const ext = media.mimetype.includes('jpeg') ? 'jpg' :
                    media.mimetype.includes('png') ? 'png' :
                        media.mimetype.includes('gif') ? 'gif' : 'jpg';
                const filename = `${waId}.${ext}`;
                const filepath = path.join(MEDIA_DIR, filename);

                fs.writeFileSync(filepath, media.data, 'base64');

                await DB.upsert({
                    wa_message_id: waId,
                    group_name: chat.name,
                    sender_name: senderName,
                    sender_jid: senderJid,
                    ts: Math.floor(tsMs / 1000),
                    audio_path: filepath,
                    audio_seconds: null,
                    question_text: `[Photo] ${msg.caption || 'Image partagée'}`,
                    transcript_raw: null,
                    transcript_torah: null,
                    sources_json: null,
                    coherence_json: null
                });

                if (!isCatchUp) {
                    console.log(`📸 Photo reçue: ${filename}`);
                }
            }
        }

    } catch (e) {
        console.error('⚠️ Erreur processMessage:', e?.message || e);
    }
}

module.exports = { processMessage };
