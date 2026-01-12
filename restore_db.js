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

            // Determine extraction target based on DB_PATH
            const extractDir = path.dirname(DB_PATH);

            // Ensure target directory exists (e.g. /data volume)
            if (!fs.existsSync(extractDir)) {
                console.log(`📂 Creating directory: ${extractDir}`);
                fs.mkdirSync(extractDir, { recursive: true });
            }

            console.log(`📂 Extracting to: ${extractDir}`);
            zip.extractAllTo(extractDir, true);
            console.log(`✅ Database restored successfully to ${DB_PATH}`);
        } catch (e) {
            console.error('❌ Failed to unzip database:', e);
        }
    } else {
        console.log('✅ Database exists and looks healthy. No restore needed.');
    }
}

module.exports = restoreDatabase;
