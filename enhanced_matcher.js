// enhanced_matcher.js — système de liaison intelligent amélioré
require('dotenv').config();
const Database = require('better-sqlite3');
const OpenAI = require('openai');
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const db = new Database(process.env.DB_PATH || 'ravqa.db');

// Paramètres améliorés
const WINDOW_SEC = 72 * 3600;        // 72h au lieu de 48h
const SAME_AUTHOR_BONUS = 0.15;      // bonus auteur augmenté
const REPLY_HARDLINK = 1.0;          // reply = 100% confiance
const TIME_DECAY_PER_H = 0.015;      // décroissance temporelle réduite
const LANG_BONUS_MATCH = 0.08;       // bonus langue augmenté
const SIM_WEIGHT = 0.8;              // poids similarité augmenté
const CONTEXT_WEIGHT = 0.2;           // poids contexte conversationnel
const THRESHOLD_ACCEPT = 0.55;       // seuil abaissé pour plus de liens
const VERIFY_WITH_GPT = true;        // vérification IA activée

// Détection de langue améliorée
function detectLanguage(text) {
  if (!text) return 'fr';
  const hebrewChars = /[\u0590-\u05FF]/;
  const arabicChars = /[\u0600-\u06FF]/;

  if (hebrewChars.test(text)) return 'he';
  if (arabicChars.test(text)) return 'ar';
  return 'fr';
}

// Similarité sémantique avec embeddings
async function getEmbedding(text) {
  try {
    const response = await client.embeddings.create({
      model: process.env.EMB_MODEL || 'text-embedding-3-small',
      input: text.slice(0, 8000) // Limite de tokens
    });
    return response.data[0].embedding;
  } catch (e) {
    console.log('Erreur embedding:', e?.message);
    return null;
  }
}

// Similarité cosinus
function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

// Similarité textuelle basique (mots-clés)
function textSimilarity(text1, text2) {
  if (!text1 || !text2) return 0;

  const words1 = new Set(text1.toLowerCase().split(/\W+/).filter(w => w.length > 2));
  const words2 = new Set(text2.toLowerCase().split(/\W+/).filter(w => w.length > 2));

  const intersection = new Set([...words1].filter(x => words2.has(x)));
  const union = new Set([...words1, ...words2]);

  return union.size > 0 ? intersection.size / union.size : 0;
}

// Analyse du contexte conversationnel
function analyzeContext(question, answer, timeGap) {
  let contextScore = 0;

  // Mots-clés halakhiques communs (étendu)
  const halakhicKeywords = [
    'chabbat', 'cacher', 'trefa', 'halavi', 'bassari', 'parve', 'mélange',
    'attente', 'lavage', 'bénédiction', 'prière', 'téfilin', 'talith',
    'nidda', 'mikvé', 'conversion', 'guer', 'mamzer', 'agouna',
    'rav', 'torah', 'loi', 'interdit', 'permis', 'manger', 'viande', 'lait',
    'mariage', 'divorce', 'kiddouch', 'havdala', 'fête', 'yom tov'
  ];

  const qWords = question.toLowerCase();
  const aWords = answer.toLowerCase();

  // Comptage des mots-clés communs
  let keywordMatches = 0;
  for (const keyword of halakhicKeywords) {
    if (qWords.includes(keyword) && aWords.includes(keyword)) {
      keywordMatches++;
    }
  }
  contextScore += Math.min(0.2, keywordMatches * 0.05);

  // NOUVEAU: Bonus fort pour messages très proches dans le temps (< 5 min)
  if (timeGap < 0.083) { // 5 minutes
    contextScore += 0.25;
  } else if (timeGap < 0.5) { // 30 minutes
    contextScore += 0.15;
  } else if (timeGap < 2) { // 2 heures
    contextScore += 0.08;
  }

  // Bonus pour questions courtes et directes
  if (question.length < 100 && answer.length > 50) {
    contextScore += 0.05;
  }

  // Pénalité pour écarts temporels très importants
  if (timeGap > 24) {
    contextScore -= 0.15;
  } else if (timeGap > 12) {
    contextScore -= 0.08;
  }

  return Math.min(0.4, Math.max(-0.1, contextScore));
}

// Vérification IA améliorée
async function verifyWithAI(question, answer) {
  try {
    const response = await client.chat.completions.create({
      model: process.env.MODEL_GPT || 'gpt-4o-mini',
      temperature: 0.1,
      messages: [
        {
          role: 'system',
          content: `Tu es un expert en analyse de correspondances halakhiques. 
          Analyse si la réponse correspond bien à la question posée.
          Considère le contexte halakhique, la cohérence thématique et la pertinence.
          Réponds par un JSON: {"score": 0.0-1.0, "reasoning": "explication courte", "confidence": "high/medium/low"}`
        },
        {
          role: 'user',
          content: `Question: "${question}"\n\nRéponse: "${answer}"\n\nAnalyse la correspondance.`
        }
      ]
    });

    const result = JSON.parse(response.choices[0].message.content);
    return {
      score: Math.max(0, Math.min(1, result.score || 0.5)),
      reasoning: result.reasoning || '',
      confidence: result.confidence || 'medium'
    };
  } catch (e) {
    console.log('Erreur vérification IA:', e?.message);
    return { score: 0.5, reasoning: 'Erreur IA', confidence: 'low' };
  }
}

// Fonction principale de liaison intelligente
async function enhancedMatchAnswerToQuestion({
  groupName,
  audioWAId,
  answerText,
  answerSender,
  answerTsSec,
  repliedToMessageId,
  questionTextHint
}) {
  console.log(`🧠 Liaison intelligente pour ${audioWAId}...`);

  // 1) Si reply direct → lien immédiat
  if (repliedToMessageId) {
    db.prepare(`
      UPDATE messages 
      SET link_question_id=?, link_confidence=?, link_method=?
      WHERE wa_message_id=?
    `).run(repliedToMessageId, REPLY_HARDLINK, 'reply', audioWAId);

    console.log(`✅ Lien direct (reply): ${audioWAId} → ${repliedToMessageId}`);
    return { qid: repliedToMessageId, confidence: REPLY_HARDLINK, method: 'reply' };
  }

  // 2) Récupération des candidats
  const candidates = db.prepare(`
    SELECT id, wa_message_id, question_text, ts, sender_name, sender_jid,
           q_embed, a_embed
    FROM messages
    WHERE group_name = ? 
      AND question_text IS NOT NULL 
      AND question_text != ''
      AND ts <= ? 
      AND ts >= ? - ?
      AND deleted_at IS NULL
    ORDER BY ts DESC
    LIMIT 100
  `).all(groupName, answerTsSec, answerTsSec, WINDOW_SEC);

  if (candidates.length === 0) {
    console.log('❌ Aucun candidat trouvé');
    return { qid: null, confidence: 0, method: 'no-candidates' };
  }

  console.log(`📋 ${candidates.length} candidats trouvés`);

  // 3) Embedding de la réponse
  let answerEmbedding = null;
  try {
    answerEmbedding = await getEmbedding(answerText);
    if (answerEmbedding) {
      db.prepare(`UPDATE messages SET a_embed=? WHERE wa_message_id=?`)
        .run(JSON.stringify(answerEmbedding), audioWAId);
    }
  } catch (e) {
    console.log('⚠️ Erreur embedding réponse:', e?.message);
  }

  // 4) Scoring des candidats
  const answerLang = detectLanguage(answerText);
  let bestMatch = { candidate: null, score: 0, details: {} };

  for (const candidate of candidates) {
    const question = candidate.question_text.trim();
    if (!question) continue;

    // Similarité sémantique
    let semanticScore = 0;
    let questionEmbedding = null;

    try {
      // Récupérer ou créer l'embedding de la question
      if (candidate.q_embed) {
        questionEmbedding = JSON.parse(candidate.q_embed);
      } else {
        questionEmbedding = await getEmbedding(question);
        if (questionEmbedding) {
          db.prepare(`UPDATE messages SET q_embed=? WHERE id=?`)
            .run(JSON.stringify(questionEmbedding), candidate.id);
        }
      }

      if (answerEmbedding && questionEmbedding) {
        semanticScore = cosineSimilarity(answerEmbedding, questionEmbedding);
      }
    } catch (e) {
      console.log('⚠️ Erreur similarité sémantique:', e?.message);
    }

    // Similarité textuelle
    const textScore = textSimilarity(question, answerText);

    // Facteurs contextuels
    const sameAuthor = candidate.sender_name && answerSender &&
      candidate.sender_name === answerSender;
    const timeGap = (answerTsSec - candidate.ts) / 3600; // heures
    const questionLang = detectLanguage(question);

    // Analyse du contexte conversationnel
    const contextScore = analyzeContext(question, answerText, timeGap);

    // Calcul du score final
    let finalScore =
      (SIM_WEIGHT * semanticScore) +
      (0.3 * textScore) +
      (CONTEXT_WEIGHT * contextScore) +
      (sameAuthor ? SAME_AUTHOR_BONUS : 0) +
      (questionLang === answerLang ? LANG_BONUS_MATCH : 0) -
      (TIME_DECAY_PER_H * Math.min(48, timeGap));

    // Bonus pour hint de question
    if (questionTextHint && questionTextHint.length > 0) {
      const hintSimilarity = textSimilarity(questionTextHint, question);
      finalScore += hintSimilarity * 0.1;
    }

    if (finalScore > bestMatch.score) {
      bestMatch = {
        candidate,
        score: finalScore,
        details: {
          semantic: semanticScore,
          text: textScore,
          context: contextScore,
          sameAuthor,
          timeGap,
          languages: { question: questionLang, answer: answerLang }
        }
      };
    }
  }

  if (!bestMatch.candidate) {
    console.log('❌ Aucun match valide trouvé');
    return { qid: null, confidence: 0, method: 'no-valid-match' };
  }

  console.log(`🎯 Meilleur candidat: score ${bestMatch.score.toFixed(3)}`);

  // 5) Vérification IA si score suffisant
  let finalScore = bestMatch.score;
  let aiVerification = null;

  if (VERIFY_WITH_GPT && bestMatch.score > 0.3) {
    try {
      aiVerification = await verifyWithAI(
        bestMatch.candidate.question_text,
        answerText
      );

      // Combinaison pondérée: 70% algorithme + 30% IA
      finalScore = 0.7 * bestMatch.score + 0.3 * aiVerification.score;

      console.log(`🤖 Vérification IA: ${aiVerification.score.toFixed(3)} (${aiVerification.confidence})`);
    } catch (e) {
      console.log('⚠️ Erreur vérification IA:', e?.message);
    }
  }

  // 6) Décision finale
  if (finalScore < THRESHOLD_ACCEPT) {
    console.log(`❌ Score insuffisant: ${finalScore.toFixed(3)} < ${THRESHOLD_ACCEPT}`);
    db.prepare(`
      UPDATE messages 
      SET link_question_id=NULL, link_confidence=?, link_method=?
      WHERE wa_message_id=?
    `).run(finalScore, 'low-score', audioWAId);

    return { qid: null, confidence: finalScore, method: 'low-score' };
  }

  // 7) Enregistrement du lien
  const method = aiVerification ? 'ai-enhanced' : 'algorithm';
  db.prepare(`
    UPDATE messages 
    SET link_question_id=?, link_confidence=?, link_method=?
    WHERE wa_message_id=?
  `).run(bestMatch.candidate.wa_message_id, finalScore, method, audioWAId);

  console.log(`✅ Lien créé: ${audioWAId} → ${bestMatch.candidate.wa_message_id} (${finalScore.toFixed(3)})`);

  return {
    qid: bestMatch.candidate.wa_message_id,
    confidence: finalScore,
    method,
    details: bestMatch.details,
    aiVerification
  };
}

module.exports = { enhancedMatchAnswerToQuestion };
