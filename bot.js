require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const path = require('path');
const fs = require('fs');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');
const { Client, LocalAuth } = require('whatsapp-web.js');
const Database = require('better-sqlite3');
const halakhaAi = require('./halakha_ai');
const OpenAI = require('openai');
const AdmZip = require('adm-zip');

// AUTO-RESTORE DB Logic moved to initBot() to prevent blocking require()
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'ravqa.db');
const DB_ZIP = path.join(__dirname, 'ravqa.db.zip');

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

// Client WhatsApp (Lazy Loading)
let client = null;

// ===============
// UTILS
// ===============

function prettyNow() {
  return new Date().toLocaleString();
}

function safeRestart(reason = 'Unknown') {
  console.error(`🔄 Restarting bot due to: ${reason}`);
  try {
    if (client) client.destroy();
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
  if (!client) return;
  console.log(`\n🚀 Starting Catch-up from ${new Date(sinceTs * 1000).toLocaleString()}`);

  try {
    const chats = await client.getChats();
    const targets = chats.filter(c => c.isGroup && GROUPS.includes(c.name));
    // ... (rest logic same)

    // Simplification for brevity in this replace block, putting logic back fully not needed if I don't touch it.
    // WAIT, I AM REPLACING GLOBAL SCOPE. I NEED TO KEEP CATCHUP LOGIC.
    // Actually, CatchUp logic uses `client`. It is defined as function so it captures `client` from closure.
    // If `client` is `let` it works fine.

    // Let's rewrite catchUp functions to be safe.
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

        for (const msg of relevant) {
          await processMessage(msg, { isCatchUp: true });
          totalProcessed++;
        }

        if (messages[0].timestamp < sinceTs) {
          finished = true;
        } else {
          lastMsgId = messages[0].id._serialized;
          if (messages.length < 50) finished = true;
        }

        await new Promise(r => setTimeout(r, 500));
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

  let hours = 24;
  if (row && row.last_ts) {
    const diffHours = (Date.now() / 1000 - row.last_ts) / 3600;
    hours = Math.ceil(diffHours) + 1;
    if (hours > 720) hours = 720;
  }

  const sinceTs = Math.floor(Date.now() / 1000) - (hours * 3600);
  await catchUpFromDate(sinceTs);
}


// ===============
// INIT
// ===============

async function initBot() {
  console.log('🚀 Initializing WhatsApp Bot...');

  // RESTORE DB IF NEEDED
  if (!fs.existsSync(DB_PATH) && fs.existsSync(DB_ZIP)) {
    console.log('📦 Found ravqa.db.zip, checking if restore needed...');
    try {
      console.log('🔄 Unzipping database with AdmZip...');
      const zip = new AdmZip(DB_ZIP);
      zip.extractAllTo(__dirname, true);
      console.log('✅ Database restored successfully');
    } catch (e) {
      console.error('❌ Failed to unzip database:', e);
    }
  }

  // INSTANTIATE CLIENT HERE (LAZY)
  console.log('🤖 Creating WhatsApp Client...');
  client = new Client({
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
        '--single-process',
        '--disable-gpu'
      ],
      timeout: 60000
    },
    authTimeoutMs: 60000
  });

  // ATTACH EVENTS
  client.on('qr', async (qr) => {
    if (process.env.LINK_PHONE_NUMBER && !global.pairingCodeRequested) {
      global.pairingCodeRequested = true;
      console.log(`📞 Demande de code d'appairage pour ${process.env.LINK_PHONE_NUMBER}...`);
      try {
        const code = await client.requestPairingCode(process.env.LINK_PHONE_NUMBER);
        console.log('🔑 CODE D\'APPAIRAGE WHATSAPP : ' + code);
      } catch (e) { console.error('Erreur Pairing:', e); }
      return;
    }
    console.log('📷 QR Code received');
    qrcode.generate(qr, { small: true });
    try { await QRCode.toFile('./qr.png', qr); } catch (e) { }
  });

  client.on('ready', async () => {
    console.log('✅ Client is ready!');
    console.log(`Target Groups: ${GROUPS.join(', ')}`);
    setTimeout(() => { runSmartCatchUp().catch(console.error); }, 5000);
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

  client.on('message', async msg => {
    try {
      await processMessage(msg);
      // Commands logic...
      if (msg.body && msg.body.startsWith('!rav')) {
        const prompt = msg.body.substring(5).trim();
        const rep = await halakhaAi.get_halakha_response(prompt, true);
        if (rep) await msg.reply(`🤖 *RavAI:* ${rep}`);
      }
    } catch (e) { console.error('Message Error:', e); }
  });

  // Watchdog
  let lastEvent = Date.now();
  client.on('message', () => lastEvent = Date.now());
  setInterval(() => {
    if (Date.now() - lastEvent > 60 * 60 * 1000) {
      console.log('💤 Idle for 1 hour, performing health check...');
      if (client) {
        client.getState().then(state => {
          console.log(`Status: ${state}`);
          if (state !== 'CONNECTED') safeRestart('Idle & Not Connected');
        }).catch(() => safeRestart('Health Check Failed'));
      }
    }
  }, 30 * 60 * 1000);


  try {
    await client.initialize();
    console.log('✅ Bot initialization started');
  } catch (e) {
    console.error('❌ Bot initialization failed:', e);
    throw e;
  }
}

module.exports = {
  get client() { return client; },
  initBot,
  GROUPS
};
