const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = './ravqa.db';
const db = new Database(DB_PATH);
db.pragma('foreign_keys = OFF'); // Allow deletions even if dependencies exist (e.g. feedback)

console.log('🧹 Starting Database Cleanup...');

// 1. Delete Images
const images = db.prepare("DELETE FROM messages WHERE audio_path LIKE '%.jpg' OR audio_path LIKE '%.jpeg' OR audio_path LIKE '%.png'").run();
console.log(`🖼️  Removed ${images.changes} image entries.`);

// 2. Delete Short/Spam Texts (No Audio)
// Keywords: merci, mp, message prive, ok, d'accord, salut, bonjour, bonsoir, shavoua tov, amen
const spamKeywords = [
    'merci', 'mp', 'message privé', 'message prive', 'ok', 'd\'accord',
    'salut', 'bonjour', 'bonsoir', 'shavoua tov', 'amen', 'top', 'super',
    'c est noté', 'c\'est noté', 'c est note', 'bien reçu', 'bien recu'
];

let spamCount = 0;
const deleteStmt = db.prepare("DELETE FROM messages WHERE id = ?");

const candidates = db.prepare("SELECT id, question_text FROM messages WHERE (audio_path IS NULL OR audio_path = '') AND length(question_text) < 50").all();

for (const msg of candidates) {
    const text = (msg.question_text || '').trim().toLowerCase();

    // Very short
    if (text.length < 5) {
        deleteStmt.run(msg.id);
        spamCount++;
        continue;
    }

    // Keyword match
    let isSpam = false;
    for (const kw of spamKeywords) {
        if (text.startsWith(kw) || text === kw) {
            deleteStmt.run(msg.id);
            spamCount++;
            isSpam = true;
            break;
        }
    }
}
console.log(`🗑️  Removed ${spamCount} short/spam text messages.`);

// 3. Deduplicate
// Strategy A: Same wa_message_id (Keep first inserted? Or last?)
// Usually wa_message_id is unique.
const duplicatesWA = db.prepare(`
    DELETE FROM messages 
    WHERE rowid NOT IN (
        SELECT MIN(rowid) 
        FROM messages 
        GROUP BY wa_message_id 
        HAVING wa_message_id IS NOT NULL
    ) 
    AND wa_message_id IS NOT NULL
`).run();
console.log(`👯 Removed ${duplicatesWA.changes} duplicates by WhatsApp ID.`);

// Strategy B: Strictly identical Question + Timestamp + Sender (for manual imports)
const duplicatesManual = db.prepare(`
    DELETE FROM messages 
    WHERE rowid NOT IN (
        SELECT MIN(rowid) 
        FROM messages 
        GROUP BY question_text, ts, sender_name
    )
    AND question_text IS NOT NULL
`).run();
console.log(`👯 Removed ${duplicatesManual.changes} duplicates by Content.`);

// 4. Vacuum
console.log('🧹 Vacuuming database...');
db.exec('VACUUM');
console.log('✅ Cleanup Complete.');

db.close();
