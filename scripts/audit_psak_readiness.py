#!/usr/bin/env python3
"""Audit : combien de réponses de la base sont servables en psak sous
l'invariant Psak Net (question d'origine + audio + transcription saine + lien) ?

Usage : python3 scripts/audit_psak_readiness.py [chemin/ravqa.db]
"""
import sqlite3, sys

DB = sys.argv[1] if len(sys.argv) > 1 else 'ravqa.db'
FLAG = "[PASSAGE INCOMPRÉHENSIBLE"
db = sqlite3.connect(DB)
c = db.cursor()
q = lambda s: c.execute(s).fetchone()[0]

SAIN = f"""a.audio_path IS NOT NULL AND a.audio_path != '' AND a.deleted_at IS NULL
   AND COALESCE(NULLIF(a.transcript_torah,''), a.transcript_raw) IS NOT NULL
   AND length(COALESCE(NULLIF(a.transcript_torah,''), a.transcript_raw)) >= 20
   AND COALESCE(NULLIF(a.transcript_torah,''), a.transcript_raw) NOT LIKE '%{FLAG}%'"""

print(f"=== AUDIT PSAK-READINESS — {DB} ===\n")
total_audio = q("SELECT COUNT(*) FROM messages a WHERE a.audio_path IS NOT NULL AND a.audio_path != '' AND a.deleted_at IS NULL")
sains = q(f"SELECT COUNT(*) FROM messages a WHERE {SAIN}")
print(f"Réponses audio actives          : {total_audio}")
print(f"... transcription saine + audio : {sains}")

a_cap = q(f"""SELECT COUNT(*) FROM messages a WHERE {SAIN} AND (
  EXISTS(SELECT 1 FROM messages qq WHERE qq.wa_message_id = a.replied_to_message_id
         AND qq.question_text IS NOT NULL AND trim(qq.question_text) != '')
  OR (a.link_confidence >= 0.8 AND (
      EXISTS(SELECT 1 FROM messages qq WHERE qq.id = a.link_question_id AND qq.question_text IS NOT NULL AND trim(qq.question_text) != '')
   OR EXISTS(SELECT 1 FROM messages qq WHERE qq.wa_message_id = a.link_question_id AND qq.question_text IS NOT NULL AND trim(qq.question_text) != ''))))""")
b_cap = q(f"""SELECT COUNT(*) FROM messages a WHERE {SAIN}
   AND a.question_text IS NOT NULL AND trim(a.question_text) != '' AND a.question_text != 'audio omis'""")
orphelines = sains - a_cap - max(0, b_cap - a_cap) if False else None

print(f"\nVERDICT A possibles (lien PROUVÉ, reply ou conf>=0.8) : {a_cap}")
print(f"VERDICT B possibles (question présente non prouvée)   : {b_cap}")
print(f"Inutilisables en l'état (à transcrire/relier)         : {sains - max(a_cap, 0) - max(b_cap, 0) if sains - a_cap - b_cap > 0 else 'recouvrement A/B, voir détail'}")
print(f"\n→ Chaque appariement validé humainement déplace une réponse de B (ou rien) vers A.")
db.close()
