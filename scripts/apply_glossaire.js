#!/usr/bin/env node
/**
 * Application du glossaire terminologique sur la base — sûre, auditée, réversible.
 *
 * Corrige le TEXTE SERVI (transcript_torah_edited > transcript_torah > transcript_raw)
 * et écrit le résultat dans transcript_torah_edited. transcript_raw n'est JAMAIS modifié.
 * Chaque passage est journalisé dans la table glossaire_journal (rollback complet).
 *
 * Usage :
 *   node scripts/apply_glossaire.js                    # DRY-RUN (défaut) : stats + diffs, zéro écriture
 *   node scripts/apply_glossaire.js --apply            # applique + journalise
 *   node scripts/apply_glossaire.js --rollback         # annule le DERNIER passage journalisé
 *   DB_PATH=/chemin/ravqa.db node scripts/apply_glossaire.js [--limit N] [--diffs N]
 */
const Database = require('better-sqlite3');
const { chargerRegles, corrigerTexte } = require('../psak_net/glossaire');

const DB_PATH = process.env.DB_PATH || './ravqa.db';
const APPLY = process.argv.includes('--apply');
const ROLLBACK = process.argv.includes('--rollback');
const argVal = (name, def) => {
    const i = process.argv.indexOf(name);
    return i > -1 ? parseInt(process.argv[i + 1], 10) : def;
};
const LIMIT = argVal('--limit', 0);
const N_DIFFS = argVal('--diffs', 12);

function main() {
    const db = new Database(DB_PATH);
    console.log(`📂 Base : ${DB_PATH}`);

    if (ROLLBACK) return rollback(db);

    const regles = chargerRegles();
    console.log(`📖 Glossaire : ${regles.length} règles chargées`);

    let sql = `
        SELECT id,
               COALESCE(NULLIF(transcript_torah_edited,''), NULLIF(transcript_torah,''), transcript_raw) AS servi,
               transcript_torah_edited AS edited_actuel
        FROM messages
        WHERE deleted_at IS NULL
          AND COALESCE(NULLIF(transcript_torah_edited,''), NULLIF(transcript_torah,''), transcript_raw) IS NOT NULL
          AND length(COALESCE(NULLIF(transcript_torah_edited,''), NULLIF(transcript_torah,''), transcript_raw)) >= 20`;
    if (LIMIT > 0) sql += ` LIMIT ${LIMIT}`;
    const rows = db.prepare(sql).all();
    console.log(`🔍 ${rows.length} réponses servies analysées\n`);

    const parTerme = new Map();
    const modifs = [];
    for (const row of rows) {
        const { texte, changements } = corrigerTexte(row.servi, regles);
        if (changements.length === 0) continue;
        modifs.push({ id: row.id, avant: row.servi, apres: texte, edited_actuel: row.edited_actuel, changements });
        for (const c of changements) {
            const cle = `${c.avant.toLowerCase()} → ${c.apres}`;
            parTerme.set(cle, (parTerme.get(cle) || 0) + 1);
        }
    }

    // ----- Rapport -----
    const totalOcc = [...parTerme.values()].reduce((a, b) => a + b, 0);
    console.log(`=== ${modifs.length} réponses à corriger, ${totalOcc} occurrences ===\n`);
    console.log('Top corrections :');
    [...parTerme.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)
        .forEach(([k, n]) => console.log(`  ${String(n).padStart(5)}× ${k}`));

    console.log(`\n=== Échantillon de ${Math.min(N_DIFFS, modifs.length)} diffs (contexte) ===`);
    for (const m of modifs.slice(0, N_DIFFS)) {
        const c = m.changements[0];
        const i = m.avant.toLowerCase().indexOf(c.avant.toLowerCase());
        const ctx = (s, j) => s.substring(Math.max(0, j - 35), j + c.avant.length + 35).replace(/\s+/g, ' ');
        console.log(`\n[id ${m.id}] ${m.changements.map(x => `${x.avant}→${x.apres}`).join(', ')}`);
        console.log(`  AVANT: …${ctx(m.avant, i)}…`);
        const j = m.apres.indexOf(c.apres);
        console.log(`  APRÈS: …${ctx(m.apres, j >= 0 ? j : i)}…`);
    }

    if (!APPLY) {
        console.log('\n🔎 DRY-RUN terminé — AUCUNE écriture. Relancer avec --apply pour appliquer.');
        db.close();
        return;
    }

    // ----- Application journalisée -----
    db.exec(`CREATE TABLE IF NOT EXISTS glossaire_journal (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT, message_id INTEGER,
        ancien_edited TEXT, nouveau TEXT, changements TEXT,
        applied_at TEXT DEFAULT (datetime('now'))
    )`);
    const runId = `gloss_${Date.now()}`;
    const upd = db.prepare('UPDATE messages SET transcript_torah_edited = ? WHERE id = ?');
    const jrn = db.prepare('INSERT INTO glossaire_journal (run_id, message_id, ancien_edited, nouveau, changements) VALUES (?,?,?,?,?)');
    const tx = db.transaction(() => {
        for (const m of modifs) {
            jrn.run(runId, m.id, m.edited_actuel, m.apres, JSON.stringify(m.changements));
            upd.run(m.apres, m.id);
        }
    });
    tx();
    console.log(`\n✅ APPLIQUÉ : ${modifs.length} réponses corrigées (run ${runId}, journal glossaire_journal).`);
    console.log('⚠️ N\'OUBLIE PAS : ré-embedder les réponses modifiées (les ids sont dans le journal).');
    db.close();
}

function rollback(db) {
    const run = db.prepare('SELECT run_id FROM glossaire_journal ORDER BY id DESC LIMIT 1').get();
    if (!run) { console.log('Rien à annuler.'); return db.close(); }
    const entries = db.prepare('SELECT message_id, ancien_edited FROM glossaire_journal WHERE run_id = ?').all(run.run_id);
    const upd = db.prepare('UPDATE messages SET transcript_torah_edited = ? WHERE id = ?');
    const del = db.prepare('DELETE FROM glossaire_journal WHERE run_id = ?');
    const tx = db.transaction(() => {
        for (const e of entries) upd.run(e.ancien_edited, e.message_id);
        del.run(run.run_id);
    });
    tx();
    console.log(`↩️ ROLLBACK : ${entries.length} réponses restaurées (run ${run.run_id}).`);
    db.close();
}

main();
