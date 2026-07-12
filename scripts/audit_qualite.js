#!/usr/bin/env node
/**
 * Audit de lisibilité des transcriptions servables — signalement journalisé, réversible.
 *
 * Pour chaque réponse servable : juge LLM (lisible/douteux/charabia). Les douteux
 * et charabia reçoivent le drapeau [PASSAGE INCOMPRÉHENSIBLE…] EN TÊTE de
 * transcript_torah_edited → transcriptionSaine() du moteur Psak les écarte
 * automatiquement, et ils partent en file de re-transcription (vocab_whisper).
 *
 * Usage :
 *   node scripts/audit_qualite.js                       # DRY-RUN sur 200 lignes (échantillon)
 *   node scripts/audit_qualite.js --all                 # DRY-RUN complet
 *   node scripts/audit_qualite.js --apply [--all]       # pose les drapeaux + journal
 *   node scripts/audit_qualite.js --rollback            # annule le dernier passage
 *   node scripts/audit_qualite.js --mock ...            # juge factice (tests sans clé)
 *   DB_PATH=/chemin/ravqa.db ... [--limit N]
 */
const Database = require('better-sqlite3');
const { jugerQualite, poserDrapeau, FLAG } = require('../psak_net/qualite_transcript');

const DB_PATH = process.env.DB_PATH || './ravqa.db';
const APPLY = process.argv.includes('--apply');
const ROLLBACK = process.argv.includes('--rollback');
const ALL = process.argv.includes('--all');
const MOCK = process.argv.includes('--mock');
const argVal = (n, d) => { const i = process.argv.indexOf(n); return i > -1 ? parseInt(process.argv[i + 1], 10) : d; };
const LIMIT = ALL ? 0 : argVal('--limit', 200);

// Juge factice pour tester la mécanique sans clé API (déterministe)
const jugeMock = async (texte) =>
    /fourrages|mystère bourrois|tafkouf/i.test(texte)
        ? { classe: 'charabia', raison: 'mock: motif charabia connu', passages_suspects: [] }
        : (texte.length % 7 === 0
            ? { classe: 'douteux', raison: 'mock: déterministe', passages_suspects: [] }
            : { classe: 'lisible', raison: 'mock', passages_suspects: [] });

async function main() {
    const db = new Database(DB_PATH);
    console.log(`📂 Base : ${DB_PATH}`);
    if (ROLLBACK) return rollback(db);

    let sql = `
        SELECT id,
               COALESCE(NULLIF(transcript_torah_edited,''), NULLIF(transcript_torah,''), transcript_raw) AS servi,
               transcript_torah_edited AS edited_actuel
        FROM messages
        WHERE deleted_at IS NULL
          AND audio_path IS NOT NULL AND audio_path != ''
          AND COALESCE(NULLIF(transcript_torah_edited,''), NULLIF(transcript_torah,''), transcript_raw) IS NOT NULL
          AND length(COALESCE(NULLIF(transcript_torah_edited,''), NULLIF(transcript_torah,''), transcript_raw)) >= 20
          AND COALESCE(NULLIF(transcript_torah_edited,''), NULLIF(transcript_torah,''), transcript_raw) NOT LIKE '%${FLAG.substring(0, 25)}%'`;
    if (LIMIT > 0) sql += ` LIMIT ${LIMIT}`;
    const rows = db.prepare(sql).all();
    console.log(`🔍 ${rows.length} transcriptions servables à évaluer${MOCK ? ' (JUGE MOCK)' : ''}\n`);

    const juge = MOCK ? jugeMock : jugerQualite;
    const resultats = { lisible: 0, douteux: 0, charabia: 0 };
    const aDraper = [];
    const BATCH = 8;
    for (let i = 0; i < rows.length; i += BATCH) {
        await Promise.all(rows.slice(i, i + BATCH).map(async (row) => {
            try {
                const j = await juge(row.servi);
                resultats[j.classe]++;
                if (j.classe !== 'lisible') aDraper.push({ ...row, jugement: j });
            } catch (e) { console.error(`id ${row.id}:`, e.message); }
        }));
        process.stdout.write(`\r⚖️ ${Math.min(i + BATCH, rows.length)}/${rows.length} jugées (charabia: ${resultats.charabia}, douteux: ${resultats.douteux})`);
    }

    console.log(`\n\n=== Résultat : ${resultats.lisible} lisibles · ${resultats.douteux} douteux · ${resultats.charabia} charabia ===`);
    for (const m of aDraper.slice(0, 8)) {
        console.log(`\n[id ${m.id}] ${m.jugement.classe} — ${m.jugement.raison}`);
        console.log(`  « ${m.servi.substring(0, 110).replace(/\s+/g, ' ')}… »`);
    }

    if (!APPLY) {
        console.log(`\n🔎 DRY-RUN — aucune écriture. ${aDraper.length} lignes seraient drapées. Relancer avec --apply.`);
        db.close(); return;
    }

    db.exec(`CREATE TABLE IF NOT EXISTS qualite_journal (
        id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, message_id INTEGER,
        classe TEXT, raison TEXT, ancien_edited TEXT,
        applied_at TEXT DEFAULT (datetime('now'))
    )`);
    const runId = `qual_${Date.now()}`;
    const upd = db.prepare('UPDATE messages SET transcript_torah_edited = ? WHERE id = ?');
    const jrn = db.prepare('INSERT INTO qualite_journal (run_id, message_id, classe, raison, ancien_edited) VALUES (?,?,?,?,?)');
    db.transaction(() => {
        for (const m of aDraper) {
            jrn.run(runId, m.id, m.jugement.classe, m.jugement.raison, m.edited_actuel);
            upd.run(poserDrapeau(m.servi), m.id);
        }
    })();
    console.log(`\n✅ ${aDraper.length} lignes drapées (run ${runId}) → exclues du circuit psak, en file de re-transcription.`);
    console.log('➡️ Re-transcrire les "charabia" avec le prompt vocab_whisper (ids dans qualite_journal).');
    db.close();
}

function rollback(db) {
    const run = db.prepare('SELECT run_id FROM qualite_journal ORDER BY id DESC LIMIT 1').get();
    if (!run) { console.log('Rien à annuler.'); return db.close(); }
    const entries = db.prepare('SELECT message_id, ancien_edited FROM qualite_journal WHERE run_id = ?').all(run.run_id);
    const upd = db.prepare('UPDATE messages SET transcript_torah_edited = ? WHERE id = ?');
    db.transaction(() => {
        for (const e of entries) upd.run(e.ancien_edited, e.message_id);
        db.prepare('DELETE FROM qualite_journal WHERE run_id = ?').run(run.run_id);
    })();
    console.log(`↩️ ROLLBACK : ${entries.length} lignes restaurées (run ${run.run_id}).`);
    db.close();
}

main();
