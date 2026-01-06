require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const path = require('path');
const fs = require('fs');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');
const { Client, LocalAuth } = require('whatsapp-web.js');
const Database = require('better-sqlite3');
const halakhaAi = require('./halakha_ai'); // IA Locale
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

// Configuration
const MEDIA_DIR = path.join(__dirname, 'media');
if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR, { recursive: true });

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'ravqa.db');
const GROUPS = [process.env.GROUP_1, process.env.GROUP_2].filter(Boolean);

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
      '--disable-gpu'
    ]
  },
  authTimeoutMs: 60000
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
    const targets = chats.filter(c => c.isGroup && GROUPS.includes(c.name));

    if (targets.length === 0) {
      console.log('⚠️ No target groups found for catch-up.');
      return 0;
    }

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

client.on('qr', async (qr) => {
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
  console.log(`Target Groups: ${GROUPS.join(', ')}`);

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

// Message Handling
client.on('message', async msg => {
  try {
    await processMessage(msg);

    // Commands
    if (msg.body) {
      if (msg.body.startsWith('!rav')) {
        const prompt = msg.body.substring(5).trim();
        const rep = await halakhaAi.get_halakha_response(prompt, true);
        if (rep) await msg.reply(`🤖 *RavAI:* ${rep}`);
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

// Self-messages (for testing)
client.on('message_create', async msg => {
  if (msg.fromMe) await processMessage(msg);
});

// Init
console.log('🚀 Initializing WhatsApp Bot...');
client.initialize().catch(e => {
  console.error('❌ Init Error:', e);
  safeRestart('Init Error');
});

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
