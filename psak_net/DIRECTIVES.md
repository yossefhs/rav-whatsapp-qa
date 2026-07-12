# DIRECTIVES — ordres de mission pour les sessions Mac

> **Mécanisme** : la session cloud (architecte) écrit ici les directives ; les
> sessions Mac lisent ce fichier après `git pull` et exécutent. L'utilisateur
> n'a plus à copier-coller — il dit seulement : « pull la branche et exécute
> les DIRECTIVES ». Marquer chaque directive ✅ avec un mot de compte-rendu
> une fois faite (et pousser la mise à jour du fichier).

---

## 📌 Directive 2026-07-06 — Lisibilité des transcriptions & routage des réponses

**Contexte** : un membre a reçu une réponse illisible — transcripts Whisper avec
citations broyées (« c'est mes fourrages dans l'Admorazaken Siman Tafkouf Raftet »
= « c'est méfourach dans l'Admour HaZaken, siman 529, sé'if 4 »), doublons
(2 fois la même Q du 14/05/2021), et un format « 🎙️ Réponses du Rav qui peuvent
correspondre » qui ne vient PAS de decidePsakVerdict.

### D1 — Terminer l'audit des points d'entrée ⬜
L'audit « tous les chemins membres passent par decidePsakVerdict » avait été
interrompu par la fin de l'éval. Le terminer : identifier le chemin qui a produit
le format multi-candidats (resolveHalakhaAnswer ? notifications d'abonnés ?
réponse privée post-groupe ?) et le router par le moteur à verdicts.
Aucune liste brute de candidats ne doit plus atteindre un membre.

### D2 — Passe de signalement qualité ⬜
Outils LIVRÉS sur cette branche — ne pas réécrire :
- `psak_net/qualite_transcript.js` : juge LLM lisible/douteux/charabia
  (signale, ne réécrit JAMAIS) + poserDrapeau() (drapeau EN TÊTE, texte intact).
- `scripts/audit_qualite.js` : CLI dry-run/--apply/--rollback, journal
  `qualite_journal`. Le drapeau posé est celui que transcriptionSaine() détecte
  déjà → exclusion automatique du circuit psak, zéro changement moteur.

Exécution : `DB_PATH=/Users/admin/rav-whatsapp-v2/ravqa.db node scripts/audit_qualite.js`
(dry-run échantillon), montrer le rapport à l'utilisateur, puis `--all`,
puis `--apply --all` après son OK.

### D3 — Re-transcription des « charabia » avec vocabulaire ⬜
- `psak_net/vocab_whisper.js` (LIVRÉ) : construirePromptVocab() → prompt de
  vocabulaire (glossaire + poskim + termes de citation) pour Whisper.
- Re-transcrire les ids classés charabia (table qualite_journal) via le module
  de transcription existant en passant ce prompt ; écrire la nouvelle
  transcription dans transcript_torah_edited (l'original raw INTACT), retirer
  le drapeau si le nouveau texte est jugé lisible, ré-embedder les lignes modifiées.
- **Brancher le même prompt sur la transcription des NOUVEAUX audios du satellite.**

### D4 — Déduplication à la présentation ⬜
Même audio / même question servie 2× (transcriptions différentes) → une seule
entrée, la meilleure (lisible > douteux ; plus récente à égalité).

### D5 — Preuve avant/après ⬜
Rejouer la question du membre (« si chabat on a du vin est-ce qu'on peut faire
kidouch sur le pain ») et montrer la réponse avant/après D1-D4.

### D6 — Propagation site ⬜
Les lignes drapées/re-transcrites modifient le texte servi → note de passation
session site : re-push Turso des lignes modifiées + purge/re-embed de leurs
vecteurs (pipeline habituel).

---

## Directives antérieures (traitées)
- ✅ Ingestion quotidienne (satellite Baileys, rodage 48 h) — 2026-07-05
- ✅ Glossaire terminologique (application + rollback prouvés) — 2026-07-05
- ✅ Moteur Psak Net bot + site — 2026-07-04/05
