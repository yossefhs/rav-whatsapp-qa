const sqlite3 = require('sqlite3').verbose();
const path = require('path');
require('dotenv').config();

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'ravqa.db');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
require('dotenv').config();

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'ravqa.db');
let db = null;

function getDb() {
  if (!db) {
    // Only initialize if DB file exists (handled by bot restoration)
    // Or if we accept creating an empty one (but we prefer restoring)
    // For safety, we just open it. If it doesn't exist, sqlite3 creates empty.
    // BUT we want to avoid creating empty if we are waiting for restore.
    // However, if we block here, we block everything.
    // Best: Initialize on first USE. 
    console.log(`🔌 Opening SQLite DB: ${DB_PATH}`);
    db = new sqlite3.Database(DB_PATH);

    // Initialize Schema
    db.serialize(() => {
      db.run(`PRAGMA journal_mode=WAL;`);
      db.run(`CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        wa_message_id TEXT UNIQUE,
        group_name TEXT,
        sender_name TEXT,
        ts INTEGER,
        audio_path TEXT,
        audio_seconds INTEGER,
        question_text TEXT,
        question_message_id TEXT,
        transcript_raw TEXT,
        transcript_torah TEXT
      )`);
      db.run(`CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT);`);
      db.run(`ALTER TABLE messages ADD COLUMN sender_jid TEXT`, err => { });
      db.run(`ALTER TABLE messages ADD COLUMN replied_to_message_id TEXT`, err => { });
      db.run(`ALTER TABLE messages ADD COLUMN sources_json TEXT`, err => { });
      db.run(`ALTER TABLE messages ADD COLUMN coherence_json TEXT`, err => { });
      db.run(`ALTER TABLE messages ADD COLUMN needs_review INTEGER DEFAULT 0`, err => { });
      db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        question_text, transcript_raw, transcript_torah, content='messages', content_rowid='id'
      )`);
      // Triggers...
      db.run(`CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, question_text, transcript_raw, transcript_torah)
        VALUES (new.id, new.question_text, new.transcript_raw, new.transcript_torah);
      END;`);
      db.run(`CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, question_text, transcript_raw, transcript_torah)
        VALUES ('delete', old.id, old.question_text, old.transcript_raw, old.transcript_torah);
        INSERT INTO messages_fts(rowid, question_text, transcript_raw, transcript_torah)
        VALUES (new.id, new.question_text, new.transcript_raw, new.transcript_torah);
      END;`);
    });
  }
  return db;
}

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    getDb().run(sql, params, function (err) { if (err) reject(err); else resolve(this); });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    getDb().get(sql, params, function (err, row) { if (err) reject(err); else resolve(row); });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    getDb().all(sql, params, function (err, rows) { if (err) reject(err); else resolve(rows); });
  });
}

module.exports = {
  async upsert(msg) {
    const sql = `
      INSERT INTO messages
        (wa_message_id, group_name, sender_name, sender_jid, ts, audio_path, audio_seconds, question_text, question_message_id, transcript_raw, transcript_torah, replied_to_message_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(wa_message_id) DO UPDATE SET
        group_name=excluded.group_name,
        sender_name=excluded.sender_name,
        sender_jid=COALESCE(excluded.sender_jid, sender_jid),
        ts=excluded.ts,
        audio_path=excluded.audio_path,
        audio_seconds=excluded.audio_seconds,
        question_text=COALESCE(excluded.question_text, question_text),
        question_message_id=COALESCE(excluded.question_message_id, question_message_id),
        transcript_raw=COALESCE(excluded.transcript_raw, transcript_raw),
        transcript_torah=COALESCE(excluded.transcript_torah, transcript_torah),
        replied_to_message_id=COALESCE(excluded.replied_to_message_id, replied_to_message_id)
    `;
    await run(sql, [
      msg.wa_message_id, msg.group_name, msg.sender_name, msg.sender_jid || null, msg.ts,
      msg.audio_path, msg.audio_seconds, msg.question_text, msg.question_message_id,
      msg.transcript_raw, msg.transcript_torah, msg.replied_to_message_id || null
    ]);
  },
  findByWA(waId) {
    return get(`SELECT * FROM messages WHERE wa_message_id=?`, [waId]);
  },
  async updateTranscript(waId, raw, torah) {
    await run(`UPDATE messages SET transcript_raw=?, transcript_torah=? WHERE wa_message_id=?`, [raw, torah, waId]);
  },
  async updateProcessedEntry(waId, corrected, torah, needsReview) {
    await run(`
      UPDATE messages 
      SET transcript_raw_edited=?, transcript_torah=?, needs_review=? 
      WHERE wa_message_id=?
    `, [corrected, torah, needsReview ? 1 : 0, waId]);
  },
  async updateEnrichment(waId, sourcesJson, coherenceJson) {
    await run(`UPDATE messages SET sources_json=?, coherence_json=? WHERE wa_message_id=?`, [sourcesJson, coherenceJson, waId]);
  },
  async updateQuestion(waId, qText, qId) {
    await run(`UPDATE messages SET question_text=?, question_message_id=? WHERE wa_message_id=?`, [qText, qId, waId]);
  },
  search(q) {
    return all(`
      SELECT m.* FROM messages_fts f
      JOIN messages m ON m.id=f.rowid
      WHERE messages_fts MATCH ?
      ORDER BY rank
      LIMIT 50
    `, [q]);
  },
  likeSearch(q) {
    const pattern = `%${q}%`;
    return all(`
      SELECT * FROM messages
      WHERE (question_text LIKE ? OR transcript_raw LIKE ? OR transcript_torah LIKE ?)
      ORDER BY ts DESC
      LIMIT 50
    `, [pattern, pattern, pattern]);
  },
  findRecentQuestionByAuthor(groupName, senderJid, tAudio, thresholdSec) {
    return get(`
      SELECT wa_message_id AS id, question_text
      FROM messages
      WHERE group_name = ? AND sender_jid = ?
        AND question_text IS NOT NULL AND ts <= ?
        AND ts >= ? - ?
      ORDER BY ts DESC LIMIT 1
    `, [groupName, senderJid, tAudio, tAudio, thresholdSec]);
  },
  findRecentQuestionInGroup(groupName, tAudio, thresholdSec) {
    return get(`
      SELECT wa_message_id AS id, question_text
      FROM messages
      WHERE group_name = ?
        AND question_text IS NOT NULL AND ts <= ?
        AND ts >= ? - ?
      ORDER BY ts DESC LIMIT 1
    `, [groupName, tAudio, tAudio, thresholdSec]);
  },
  latest(limit) {
    return all(`SELECT * FROM messages ORDER BY ts DESC LIMIT ?`, [limit]);
  },
  getState(key) {
    return get(`SELECT value FROM state WHERE key=?`, [key]).then(row => row?.value || null);
  },
  setState(key, val) {
    return run(`INSERT INTO state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, [key, String(val)]);
  },
  // Accès direct à la DB pour requêtes avancées (RAG, tests)
  getDb() {
    const Database = require('better-sqlite3');
    const dbPath = process.env.DB_PATH || require('path').join(__dirname, 'ravqa.db');
    return new Database(dbPath, { readonly: true });
  }
};

