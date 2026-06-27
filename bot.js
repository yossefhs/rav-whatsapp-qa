require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const path = require('path');
const fs = require('fs');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');
const { Client, LocalAuth } = require('whatsapp-web.js');
const Database = require('better-sqlite3');
const halakhaAi = require('./halakha_ai'); // IA Locale (V1 - Deprecated for commands)
const { routeAndAnswer } = require('./ai_router'); // IA V2 (Router)
const OpenAI = require('openai'); // IA Cloud

let openai = null;
if (process.env.OPENAI_API_KEY) {
  try {
    openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  } catch (e) {
    console.error('OpenAI Init Error:', e.message);
  }
}
const { processMessage } = require('./message_processor');
const { isTargetGroup, getConfiguredGroups, logConfiguredGroups } = require('./groups');

// Configuration
const MEDIA_DIR = path.join(__dirname, 'media');
if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR, { recursive: true });

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'ravqa.db');
const GROUPS = getConfiguredGroups();

// Client WhatsApp
const client = new Client({
  authStrategy: new LocalAuth({ clientId: 'rav' }),
  puppeteer: {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      // '--single-process', // Removed for stability on macOS
      '--disable-gpu',
      '--disable-extensions',
      '--disable-component-extensions-with-background-pages'
    ],
    timeout: 120000,
    protocolTimeout: 360000,
  },
  authTimeoutMs: 120000
});

// ===============
// UTILS
// ===============

function prettyNow() {
  return new Date().toLocaleString();
}

function safeRestart(reason = 'Unknown') {
  console.error(`🔄 Restarting bot due to: ${reason}`);
  try {
    client.destroy();
  } catch (e) {
    console.error('Error destroying client:', e);
  }
  // PM2 will handle the restart
  setTimeout(() => process.exit(1), 1000);
}

// ===============
// CATCH-UP LOGIC
// ===============

async function catchUpFromDate(sinceTs) {
  console.log(`\n🚀 Starting Catch-up from ${new Date(sinceTs * 1000).toLocaleString()}`);

  try {
    const chats = await client.getChats();
    const targets = chats.filter(c => c.isGroup && isTargetGroup(c.name));

    if (targets.length === 0) {
      console.log('⚠️ No target groups found for catch-up.');
      const groupNames = chats.filter(c => c.isGroup).map(c => `"${c.name}"`);
      console.log(`ℹ️ Groupes visibles par le bot : [${groupNames.join(', ')}]`);
      console.log(`ℹ️ Groupes configurés : [${getConfiguredGroups().map(g => `"${g}"`).join(', ')}]`);
      return 0;
    }

    console.log(`📂 ${targets.length} groupe(s) ciblé(s) trouvé(s) : ${targets.map(c => `"${c.name}"`).join(', ')}`);

    let totalProcessed = 0;

    for (const chat of targets) {
      console.log(`📂 Processing group: ${chat.name}`);
      let lastMsgId = undefined;
      let finished = false;

      while (!finished) {
        const options = { limit: 50 };
        if (lastMsgId) options.before = lastMsgId;

        const messages = await chat.fetchMessages(options);
        if (!messages || messages.length === 0) break;

        const relevant = messages.filter(m => m.timestamp >= sinceTs);

        // Process newest first (array is oldest -> newest)
        // We actually want to process them, order doesn't matter much for DB upsert but chrono is better for logs
        for (const msg of relevant) {
          await processMessage(msg, { isCatchUp: true });
          totalProcessed++;
        }

        if (messages[0].timestamp < sinceTs) {
          finished = true; // We went far enough back
        } else {
          lastMsgId = messages[0].id._serialized;
          if (messages.length < 50) finished = true; // End of history
        }

        await new Promise(r => setTimeout(r, 500)); // Rate limit
      }
    }

    console.log(`✅ Catch-up completed. Processed ${totalProcessed} messages.`);
    return totalProcessed;
  } catch (e) {
    console.error('❌ Catch-up error:', e);
    return 0;
  }
}

async function runSmartCatchUp() {
  const db = new Database(DB_PATH);
  const row = db.prepare('SELECT MAX(ts) as last_ts FROM messages').get();
  db.close();

  let hours = 24; // Default 24h
  if (row && row.last_ts) {
    const diffHours = (Date.now() / 1000 - row.last_ts) / 3600;
    hours = Math.ceil(diffHours) + 1; // +1h safety
    if (hours > 720) hours = 720; // Max 30 days
  }

  const sinceTs = Math.floor(Date.now() / 1000) - (hours * 3600);
  await catchUpFromDate(sinceTs);
}

// ===============
// EVENTS
// ===============

// Hardcode temporaire pour forcer l'appairage
const PHONE_NUMBER = process.env.LINK_PHONE_NUMBER;

client.on('qr', async (qr) => {
  // Mode Appairage par Code (Plus stable pour le cloud)
  if (PHONE_NUMBER && !global.pairingCodeRequested) {
    global.pairingCodeRequested = true;
    console.log(`📞 Demande de code d'appairage pour ${PHONE_NUMBER}...`);
    try {
      const code = await client.requestPairingCode(PHONE_NUMBER);
      console.log('--------------------------------------------------');
      console.log('🔑 CODE D\'APPAIRAGE WHATSAPP : ' + code);
      console.log('👉 Sur votre téléphone : Réglages > Appareils connectés > Connecter > "Se connecter avec le numéro"');
      console.log('--------------------------------------------------');
    } catch (e) {
      console.error('Erreur Pairing Code:', e);
    }
    return;
  }

  // Fallback QR Code
  console.log('📷 QR Code received');
  console.log('SCAN THIS STRING IF IMAGE FAILS:');
  console.log(qr);
  console.log('--------------------------------');
  try {
    qrcode.generate(qr, { small: true });
  } catch (e) {
    console.error('QR Terminal Generation Error:', e);
  }

  try {
    await QRCode.toFile('./qr.png', qr);
    // Visual fallback for MacOS only
    if (process.platform === 'darwin') require('child_process').exec('open ./qr.png');
  } catch (e) {
    console.error('QR File Error:', e);
  }
});

client.on('ready', async () => {
  console.log('✅ Client is ready!');
  logConfiguredGroups();

  // Initial Catch-up
  setTimeout(() => {
    runSmartCatchUp().catch(console.error);
  }, 5000);
});

client.on('authenticated', () => console.log('🔐 Authenticated'));
client.on('auth_failure', (msg) => {
  console.error('🚫 Auth failure:', msg);
  safeRestart('Auth Failure');
});

client.on('disconnected', (reason) => {
  console.log('🔌 Disconnected:', reason);
  safeRestart(`Disconnected: ${reason}`);
});

// Feedback Manager
const { FeedbackManager } = require('./feedback_system');
const feedbackManager = new FeedbackManager();

// Cache to store context for feedback (msgId -> { query, sourceIds })
const responseCache = new Map();

// Message Handling
client.on('message', async msg => {
  try {
    await processMessage(msg);

    // Commands
    if (msg.body) {
      if (msg.body.startsWith('!rav')) {
        const prompt = msg.body.substring(5).trim();
        // V2 MIGRATION: Utilisation du Routeur Agentique
        console.log(`🤖 [Bot V2] Processing '!rav' command for ${msg.from}`);

        try {
          const response = await routeAndAnswer(prompt);
          // WhatsApp ne supporte pas le streaming, on envoie la réponse complète
          const sentMsg = await msg.reply(`🤖 *RavAI V2:* ${response.answer}`);

          // Store context for feedback
          if (sentMsg && sentMsg.id && response.sources) {
            const key = sentMsg.id._serialized;
            responseCache.set(key, {
              query: prompt,
              sourceIds: response.sources.map(s => s.id)
            });
            // Cleanup cache after 24h
            setTimeout(() => responseCache.delete(key), 24 * 60 * 60 * 1000);
          }

          console.log(`[Bot V2] Réponse générée via Qdrant/Hybrid pour : ${msg.from} (Intent: ${response.intent})`);
        } catch (error) {
          console.error('❌ Bot V2 Error:', error);
          await msg.reply('⚠️ Erreur du système V2. Veuillez réessayer.');
        }
      } else if (msg.body.startsWith('!gpt')) {
        if (!openai) {
          await msg.reply('❌ OpenAI non configuré (Clé manquante)');
          return;
        }
        const prompt = msg.body.substring(5).trim();
        const completion = await openai.chat.completions.create({
          model: process.env.MODEL_GPT || "gpt-4o-mini",
          messages: [
            { role: "system", content: "Tu es un assistant expert en Torah." },
            { role: "user", content: prompt }
          ]
        });
        await msg.reply(`✨ *GPT:* ${completion.choices[0].message.content}`);
      }
    }
  } catch (e) {
    console.error('Message Error:', e);
  }
});

// Feedback Handling (Reactions)
client.on('message_reaction', async (reaction) => {
  // Only process reactions on our own messages
  if (!reaction.msgId.fromMe) return;

  const key = reaction.msgId._serialized;
  const context = responseCache.get(key);

  if (context) {
    const emoji = reaction.reaction;
    let isRelevant = null;

    if (emoji === '👍' || emoji === '👍🏻' || emoji === '👍🏼' || emoji === '👍🏽' || emoji === '👍🏾' || emoji === '👍🏿') {
      isRelevant = true;
    } else if (emoji === '👎' || emoji === '👎🏻' || emoji === '👎🏼' || emoji === '👎🏽' || emoji === '👎🏾' || emoji === '👎🏿') {
      isRelevant = false;
    }

    if (isRelevant !== null) {
      console.log(`📝 Processing feedback '${emoji}' for query "${context.query}"`);

      // Record feedback for each used source
      let count = 0;
      for (const sourceId of context.sourceIds) {
        feedbackManager.addFeedback({
          query: context.query,
          messageId: sourceId,
          isRelevant: isRelevant,
          rating: isRelevant ? 5 : 1,
          comment: `Vote via Reaction ${emoji}`,
          userIp: 'whatsapp-bot'
        });
        count++;
      }
      console.log(`✅ Feedback recorded for ${count} sources.`);
    }
  }
});

// Self-messages (for testing)
client.on('message_create', async msg => {
  if (msg.fromMe) await processMessage(msg);
});

// Init
// Initialisation du Bot
async function initBot() {
  console.log('🚀 Initializing WhatsApp Bot...');
  try {
    await client.initialize();
    console.log('✅ Bot initialization started');
  } catch (e) {
    console.error('❌ Bot initialization failed:', e);
    throw e;
  }
}

module.exports = {
  client,
  initBot,
  GROUPS
};

// Watchdog
let lastEvent = Date.now();
client.on('message', () => lastEvent = Date.now());
setInterval(() => {
  if (Date.now() - lastEvent > 60 * 60 * 1000) { // 1 hour idle
    console.log('💤 Idle for 1 hour, performing health check...');
    client.getState().then(state => {
      console.log(`Status: ${state}`);
      if (state !== 'CONNECTED') safeRestart('Idle & Not Connected');
    }).catch(() => safeRestart('Health Check Failed'));
  }
}, 30 * 60 * 1000);

// Auto-start if run directly
if (require.main === module) {
  initBot().catch(err => console.error('Failed to start bot:', err));
}
