const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'ravqa.db');
const DB_ZIP = path.join(__dirname, 'ravqa.db.zip');

async function restoreDatabase() {
    console.log('🔍 Checking Database status...');

    // Check if ZIP exists
    if (!fs.existsSync(DB_ZIP)) {
        console.log('⚠️ No ravqa.db.zip found. Skipping restore.');
        return;
    }

    let shouldRestore = false;
    let cause = '';

    if (!fs.existsSync(DB_PATH)) {
        shouldRestore = true;
        cause = 'Missing DB file';
    } else {
        try {
            const stats = fs.statSync(DB_PATH);
            if (stats.size < 1024 * 1024) { // < 1MB
                shouldRestore = true;
                cause = `DB too small (${stats.size} bytes)`;
            }
        } catch (e) {
            shouldRestore = true;
            cause = 'Error reading DB stats';
        }
    }

    if (shouldRestore) {
        console.log(`📦 Restore Triggered: ${cause}`);
        try {
            console.log('🔄 Unzipping database (Async)...');
            const zip = new AdmZip(DB_ZIP);
            // Async unzip not supported well by adm-zip synchronously, but we wrap in async function
            // to essentially run it in the main event loop tick but we are called asynchronously.
            // Actually adm-zip is synchronous. We should accept the brief blocking OR use async version if available.
            // AdmZip extractAllTo is sync. 
            // BUT, if we call this AFTER app.listen, inside a setImmediate or just async function call,
            // the server is ALREADY listening. It will briefly block the Event Loop (CPU bound), 
            // stopping new requests processing for ~1-2s, but the PORT IS OPEN.
            // This is safer than blocking BEFORE app.listen.

            zip.extractAllTo(__dirname, true);
            console.log('✅ Database restored successfully');
        } catch (e) {
            console.error('❌ Failed to unzip database:', e);
        }
    } else {
        console.log('✅ Database exists and looks healthy. No restore needed.');
    }
}

module.exports = restoreDatabase;
