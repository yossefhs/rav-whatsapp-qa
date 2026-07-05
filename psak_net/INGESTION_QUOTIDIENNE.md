# Ingestion quotidienne — chaque question et chaque réponse du Rav entre en base, chaque jour

> Objectif : la base n'est plus un stock historique qu'on répare, mais un corpus
> vivant. Chaque nouvelle paire question↔réponse capturée proprement est un
> futur psak servable — idéalement un Verdict A dès sa naissance.

## 0. LA règle d'or (organisationnelle, pas technique)

**Demander au Rav (et aux admins qui postent ses audios) de répondre en
« Répondre » (reply WhatsApp) au message de la question.**

Un reply = lien question↔réponse **prouvé à 100 %** → la paire naît directement
« Verdict A-capable », sans appariement algorithmique ni validation manuelle.
C'est le levier n°1 de croissance du psak confirmé : gratuit, immédiat, fiable.
Sans reply, la paire passe par l'appariement + la file de validation admin.

## 1. Événements capturés (groupes configurés uniquement)

| Événement | Action |
|---|---|
| Message **texte** d'un membre | stocker comme QUESTION : `wa_message_id` (UNIQUE, idempotence), groupe, auteur (jid+nom), ts, texte |
| Message **audio/ptt du Rav** (jid du Rav ou admins autorisés) | pipeline RÉPONSE (§2) |
| Message texte **du Rav** en reply à une question | stocker comme réponse TEXTE, lien reply prouvé |
| Réactions / autres | ignorer (ou journal brut séparé si souhaité) |

## 2. Pipeline d'une réponse audio (asynchrone, ne bloque JAMAIS le bot)

```
1. Sauvegarder l'audio        → fichier nommé par wa_message_id (stable),
                                 + upload B2 (le même bucket que le site)
2. Stocker la ligne            → messages(audio_path, ts, sender, replied_to_message_id…)
3. Lier                        → reply présent ? link 'reply' prouvé
                                 sinon enhanced_matcher → conf >= 0.8 : lien retenu
                                 conf < 0.8 : FILE DE VALIDATION ADMIN (jamais servi en A)
4. Transcrire (file de retry)  → Whisper (gpt-4o-transcribe, fallback whisper-1) → transcript_raw
5. Corriger la terminologie    → corrigerTexte() du glossaire (psak_net/glossaire.js)
                                 → transcript_torah_edited + journal glossaire_journal
6. Indexer incrémentalement    → embedding de la QUESTION liée → question_embeddings
                                 → embedding de la réponse → index vectoriel du bot
7. Marquer 'pret_a_servir'     → seulement si : transcription saine + question liée + audio présent
                                 (l'invariant Psak Net s'applique dès la naissance de la donnée)
```

## 3. Synchronisation vers le site (Turso)

- Export **quotidien** (cron, ex. 03h00 sauf Chabbat/fêtes) des nouvelles lignes
  `pret_a_servir` : append dans `qa` + `qa_vec` + `psak_meta` + `psak_qvec`
  (même pipeline éprouvé que le re-push, en mode incrémental).
- Une paire dont le lien est en attente de validation admin N'EST PAS poussée.

## 4. Robustesse (leçons des pannes passées)

- **Idempotence** : `wa_message_id` UNIQUE partout ; re-traiter un message déjà vu = no-op.
- **File de retry** pour la transcription (audio arrivé pendant une panne OpenAI → retenté).
- **Jamais bloquant** : la capture tourne en tâche de fond ; si elle échoue, le bot
  continue de répondre (et journalise l'échec pour rattrapage).
- **Chabbat-aware** : réutiliser le mécanisme d'arrêt existant ; au redémarrage,
  **rattrapage** des messages manqués via l'historique du groupe (fetchMessages).
- **Écriture DB** : le bot et rav-server-v2 partagent la base → écritures en
  transactions courtes, WAL activé.

## 5. Critères d'acceptation (à vérifier après 48 h de test)

1. Nombre de questions stockées = nombre de questions postées dans les groupes (0 perte).
2. Toute réponse audio du Rav est transcrite et corrigée en < 15 min (hors Chabbat).
3. 100 % des réponses par reply sont liées `method='reply'` automatiquement.
4. Aucun doublon (re-livraisons WhatsApp absorbées par l'idempotence).
5. Les paires nées d'un reply ressortent en Verdict A sur une re-demande quasi identique.
6. Le site sert les paires de la veille après le cron de 03h00.

## 6. Ce qui existe déjà (à réutiliser, pas à réécrire)

| Brique | Où |
|---|---|
| Pipeline de capture de référence (écoute, download, upsert idempotent) | ce repo : `message_processor.js`, `db.js` (upsert ON CONFLICT) |
| Transcription Whisper FR avec retry | ce repo : `transcribe_openai.js` |
| Nettoyage anti-hallucination (drapeaux) | ce repo : `torah_transcription.js` (cleanTranscription UNIQUEMENT — jamais buildTorahVersion sur le chemin psak) |
| Appariement Q↔R avec confiance | ce repo : `enhanced_matcher.js` (avec le fix float de repair_link_semantics) |
| Correction terminologique | branche : `psak_net/glossaire.js` (corrigerTexte) |
| File de validation admin | bot live : `feedbackStore` (déjà branché sur le flux psak) |
| Arrêt/redémarrage Chabbat | bot live : mécanisme existant |
