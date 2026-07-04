# Spécification « Psak Net » — Bot Q/R Rav Abichid

> Objectif : le bot donne le psak du Rav de façon **claire et nette, sans réserve**,
> UNIQUEMENT quand il a retrouvé une vraie question antérieure correspondante avec la
> vraie réponse du Rav. Sinon, il le **signale explicitement**. Jamais d'entre-deux flou.

## 1. Les trois verdicts (et seulement trois)

Chaque question entrante se termine par exactement UN de ces trois états :

### ✅ VERDICT A — PSAK CONFIRMÉ
Le bot affirme la réponse sans réserve, car la correspondance est prouvée.

Conditions (TOUTES obligatoires) :
1. **Similarité question↔question ≥ 0.90** (embedding de la question seule, pas Q+R fusionnés)
   — OU deux sources indépendantes ≥ 0.85 qui donnent le même psak.
2. **Le lien question→réponse est fiable** : `link_method = 'reply'` (lien WhatsApp direct)
   OU `link_confidence ≥ 0.80` validé.
3. **La transcription est saine** : pas de drapeau `[PASSAGE INCOMPRÉHENSIBLE À VÉRIFIER SUR L'AUDIO]`,
   `transcript_torah` non vide.
4. **Double vérification LLM (juge)** : un appel indépendant (temperature 0) reçoit la nouvelle
   question + la Q/R retrouvée et répond `MATCH_EXACT / MATCH_PROCHE / NO_MATCH`.
   Verdict A exige `MATCH_EXACT`.

Format de sortie (net, pas de conditionnel) :
```
✅ Le Rav a déjà répondu à cette question.

📖 Psak du Rav : [transcript_torah de la réponse]

🎧 Écouter la réponse du Rav : [lien audio]
📅 Question d'origine ([date]) : "[question_text]"
```
INTERDIT dans ce verdict : « il semble », « sous réserve », « probablement », enrichissement
Sefaria, toute synthèse générative. Le texte du psak = la transcription validée, telle quelle.

### 🟡 VERDICT B — QUESTION PROCHE (à signaler, pas à trancher)
Le bot a trouvé une question **similaire mais pas identique** (0.75 ≤ similarité < 0.90,
ou juge = `MATCH_PROCHE`, ou lien Q→R moyen 0.55–0.80).

Format de sortie (clair sur la limite, sans noyer) :
```
🟡 Je n'ai pas trouvé cette question exacte, mais le Rav a répondu à une question proche :

❓ Question posée à l'époque : "[question_text]"
📖 Réponse du Rav dans CE cas-là : [transcript_torah]
🎧 Audio : [lien]

⚠️ Votre cas n'est pas identique — posez votre question au Rav pour un psak sur votre situation.
```

### ⛔ VERDICT C — AUCUNE SOURCE
Rien au-dessus de 0.75, ou juge = `NO_MATCH`, ou seule source disponible a une
transcription douteuse / un lien Q→R non fiable.

Format de sortie (une phrase, nette) :
```
⛔ Le Rav n'a pas encore répondu à cette question dans nos archives.
Posez-la directement au Rav dans le groupe.
```
INTERDIT : donner une réponse Sefaria, une synthèse GPT, ou « voici quand même des résultats ».

## 2. Règle d'or
> **La netteté vient de la certitude de la donnée, pas du ton du texte.**
> Le bot n'est jamais autorisé à formuler lui-même une halakha : dans le Verdict A il CITE,
> dans le Verdict B il CITE en signalant l'écart, dans le Verdict C il se tait.
> Toute synthèse générative (GPT-4o « Chain of Thought ») est supprimée du chemin psak.

## 3. Pipeline technique

```
nouvelle question
  → normalisation + reformulation (correction orthographe, mots-clés halakhiques)
  → recherche top-10 sur q_embed (embedding QUESTION SEULE)
  → filtre dur : lien Q→R fiable + transcription saine
  → juge LLM (MATCH_EXACT / MATCH_PROCHE / NO_MATCH) sur le top-3
  → verdict A / B / C selon §1
  → sortie formatée + audio TOUJOURS joint quand il existe
```

## 4. Chantier données prérequis (mesuré sur ravqa.db du 20/01/2026)

Le verdict A n'est possible que si la donnée est fiable. État réel mesuré :

| Donnée | État actuel | Cible |
|---|---|---|
| Messages totaux | 14 071 | — |
| Audios (réponses du Rav) | 7 266 | — |
| Audios transcrits | 5 197 (72 %) | 100 % → **2 069 audios à transcrire** |
| Audios liés à leur question (reply) | 261 | — |
| Audios liés par algorithme | 316 (dont 22 seulement ≥ 0.90) | **~6 700 audios à lier ou marquer non-liables** |
| Liens 0.70–0.90 à réviser humainement | 146 | file de validation admin |
| Embeddings indexés | 2 671 (19 % de la base) | 100 % des paires Q/R validées |
| Embedding par question seule (q_embed) | partiel | systématique |

Ordre de priorité :
1. **Ré-indexer avec q_embed séparé** (le matching question↔question est le cœur du verdict A).
2. **Transcrire les 2 069 audios manquants** (transcribe_openai → torah_transcription, avec drapeaux).
3. **Relancer enhanced_matcher sur les ~6 700 audios non liés** ; tout lien 0.55–0.80 part en
   file de validation humaine (dashboard admin), pas en production.
4. Les paires validées humainement deviennent le « noyau or » : elles seules peuvent produire
   un Verdict A tant que le reste n'est pas validé.

## 5. Paramètres (à ajuster après mesure sur jeu de test)

| Paramètre | Valeur initiale |
|---|---|
| SEUIL_PSAK_CONFIRME (sim. question↔question) | 0.90 |
| SEUIL_PROCHE | 0.75 |
| SEUIL_LIEN_FIABLE (link_confidence) | 0.80 |
| Juge LLM | temperature 0, réponse forcée JSON `{verdict, raison}` |
| Nb sources max affichées | 3 |

## 6. Mesure de qualité (avant tout déploiement)

Constituer un jeu de 50 questions test (25 déjà répondues, 15 proches, 10 inédites).
Mesurer : % de Verdict A corrects (objectif : 100 % — un seul faux Verdict A est disqualifiant),
% de B/C corrects (objectif ≥ 90 %). Un faux « psak confirmé » est plus grave que
dix « posez la question au Rav » inutiles.

---
*Cette spécification est portable : elle s'applique au bot actuel (machine locale + API
ravabichid.org) comme à ce dépôt. Les modules réutilisables d'ici : `torah_transcription.js`
(drapeaux anti-hallucination), `enhanced_matcher.js` (liaison Q→R avec confiance),
`transcribe_openai.js` (transcription FR).*
