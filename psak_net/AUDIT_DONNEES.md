# Audit de préparation des données — Psak Net

*Mesuré sur `ravqa.db` (snapshot du 20/01, 14 071 messages) avec
`scripts/audit_psak_readiness.py`. Rejouable sur toute version de la base.*

## Chiffres mesurés sous l'invariant Psak Net

| Mesure | Valeur |
|---|---|
| Réponses audio actives | 5 263 |
| … avec transcription saine (≥ 20 car., sans drapeau incompréhensible) | 3 595 |
| **Servables en Verdict A** (lien question↔réponse PROUVÉ : reply ou confiance ≥ 0.8) | **4** |
| **Servables en Verdict B** (question présente sur la ligne, lien non prouvé) | **2 352** |
| Inutilisables en l'état (ni question identifiable, ni transcription saine) | ~1 200 |

## Constats techniques importants

1. **Le lien Q↔R est le goulot absolu.** Sur 261 `replied_to_message_id`, seuls
   **4** pointent vers une question existante avec texte. Les liens
   algorithmiques à confiance ≥ 0.8 pointent tous vers des cibles introuvables
   ou vides (probable mélange de sémantique `id` / `wa_message_id` :
   231 liens joignent sur `id`, 16 sur `wa_message_id`, 0 des deux côtés pour
   les hautes confiances).
2. **Conséquence assumée** : au lancement, le bot servira essentiellement des
   Verdicts B (« question proche/présente, à vérifier ») et C. C'est le
   comportement VOULU par l'invariant : mieux vaut 4 psakim irréprochables que
   2 000 psakim non prouvés.
3. **Chaque appariement validé humainement fait monter une réponse de B vers A.**
   La file de validation admin est donc le levier de croissance n°1 du Verdict A.
4. Les scores de similarité de l'index actuel (`message_embeddings`) encodent
   question+réponse fusionnées → lancer `scripts/index_questions_v3.js` (clé
   OpenAI requise) pour l'index question-seule avant de calibrer le seuil 0.90.

## Ordre des chantiers données (inchangé, maintenant prouvé par la mesure)

1. Réparer la sémantique des liens (`link_question_id` : id vs wa_message_id) et
   ré-apparier — chaque lien validé = +1 psak Verdict A.
2. Indexer `question_embeddings` (script prêt).
3. Transcrire les ~1 700 audios restants sans transcription saine.
