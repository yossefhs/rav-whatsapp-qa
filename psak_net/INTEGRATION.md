# Intégration du moteur Psak Net dans le bot live

> **Implémentation de référence exécutable dans CE dépôt** : `psak_net/routes.js`
> expose `POST /api/psak` + `GET /api/psak/health`, branchés dans `server.js` via
> `setupPsakEndpoints(app)`, avec `psak_net/candidats.js` comme hydrateur
> (question d'origine par preuve : reply > lien > question portée). Testé de bout
> en bout sur la vraie ravqa.db. Le bot du Mac peut soit copier `psak_net/`,
> soit appeler directement cet endpoint. État des données : `AUDIT_DONNEES.md`.

> Cible : le bot WhatsApp sur le Mac (`/Users/admin/whatsapp-web.js`).
> Copier le dossier `psak_net/` tel quel dans le projet du bot. Zéro dépendance
> (fetch natif, Node >= 18). Le juge appelle l'API Anthropic avec la clé déjà
> utilisée par `synthesizeRavAnswer` (env `ANTHROPIC_API_KEY`).

## 1. Point de branchement

Dans le flux `!rav` / question de groupe (là où le bot appelle aujourd'hui la
recherche sémantique puis la synthèse), remplacer la fin du pipeline par :

```js
const { deciderVerdict, formaterReponse } = require('./psak_net/psak_engine');

// 1) recherche existante (Qdrant + recollage multi-segments déjà live)
const bruts = await searchSemantic(question, 10, 0.4); // renvoie déjà l'id exposé

// 2) adapter au format du moteur
const candidats = bruts.map(r => ({
    id: r.id,
    score: r.score,                 // similarité question<->question (voir §3)
    question: r.question_text,      // la question d'origine posée au Rav
    answer: r.recolledAnswer || r.answer, // réponse RECOLLÉE (multi-segments)
    audioUrl: r.audio_url,
    linkMethod: r.link_method,      // 'reply' | 'ai-enhanced' | ...
    linkConfidence: r.link_confidence,
    timestamp: r.ts,
}));

// 3) santé de la recherche : si Qdrant est down, NE PAS servir le fallback en silence
const searchHealthy = await qdrantEstVivant(); // ping /collections en 2s max

// 4) verdict + message
const resultat = await deciderVerdict(question, candidats, { searchHealthy });
const message = formaterReponse(resultat);
// → passer `message` à la file de validation humaine existante avant envoi
```

## 2. Les 4 verdicts produits

| Verdict | Sens | Le bot… |
|---|---|---|
| `A` | vrai match prouvé (score ≥ 0.90 + lien Q↔R prouvé + juge MATCH_EXACT) | affirme sans réserve et CITE la réponse + audio |
| `B` | question proche ou lien non prouvé | cite en signalant clairement l'écart |
| `C` | rien de fiable | une phrase nette : « posez la question au Rav » |
| `D` | recherche sémantique down | s'abstient explicitement (jamais de mode dégradé silencieux) |

`formaterReponse()` produit le texte WhatsApp final pour chaque cas.
**Aucune synthèse générative sur le chemin psak** : en A et B le texte du psak
est la transcription validée, citée telle quelle.

> **INVARIANT PSAK (non négociable)** : tout psak servi (Verdict A comme B)
> porte TOUJOURS la question d'origine posée au Rav ET le lien audio source.
> Un candidat sans question d'origine ou sans audio est écarté par le moteur
> (`sourceComplete()`), quel que soit son score. Si une réponse importante est
> écartée pour cette raison, la correction est côté données (retrouver
> l'audio_path / relier la question), jamais côté assouplissement du moteur.

## 3. Prérequis données (importants)

1. **`score` doit être une similarité question↔question.** Si l'index actuel
   encode question+réponse fusionnées, le seuil 0.90 sera rarement atteint et
   tout sortira en B/C. Ré-indexer avec un embedding de la question seule
   (cf. levier #4 de la feuille de route / `PSAK_NET_SPEC.md` §4).
2. **`linkMethod` / `linkConfidence`** viennent de `ravqa.db`
   (`messages.link_method`, `messages.link_confidence`). Tant que les ~9 400
   réponses orphelines ne sont pas appariées, la plupart des candidats
   plafonneront au Verdict B — c'est VOULU : mieux vaut « proche, à vérifier »
   qu'un faux « confirmé ».
3. **Réponses recollées** : passer la réponse multi-segments (déjà live),
   jamais un fragment.

## 4. Réglages (env)

| Variable | Défaut | Rôle |
|---|---|---|
| `PSAK_SEUIL_CONFIRME` | 0.90 | similarité min pour un Verdict A |
| `PSAK_SEUIL_PROCHE` | 0.75 | similarité min pour un Verdict B |
| `PSAK_SEUIL_LIEN` | 0.80 | confiance min du lien Q↔R (hors reply) |
| `PSAK_JUDGE_MODEL` | `claude-opus-4-8` | modèle du juge (json_schema forcé) |

Le juge utilise les structured outputs (`output_config.format` json_schema) :
la réponse est toujours un JSON valide `{verdict, raison}` — pas de parsing fragile.

## 5. Éval avant mise en service

Brancher `deciderVerdict` dans le harnais `eval/` existant (le paramètre `judge`
est injectable pour les tests) et mesurer sur le gold vérifié :
- % de Verdict A corrects — **objectif 100 %, un seul faux A est disqualifiant** ;
- les 5 questions « abstain » du gold doivent sortir en C (c'était 0/5 avant) ;
- % de B pertinents.

Tant que le taux de faux A n'est pas nul sur le gold, augmenter
`PSAK_SEUIL_CONFIRME` ou durcir le prompt du juge — jamais l'inverse.
