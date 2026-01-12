const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'ravqa.db');
const DB_ZIP = path.join(__dirname, 'ravqa.db.zip');

const { execSync } = require('child_process');

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
            // Determine extraction target based on DB_PATH logic
            // If DB_PATH is /data/ravqa.db, want directory /data
            const extractDir = path.dirname(DB_PATH);

            // Ensure target directory exists (e.g. /data volume)
            if (!fs.existsSync(extractDir)) {
                console.log(`📂 Creating directory: ${extractDir}`);
                fs.mkdirSync(extractDir, { recursive: true });
            }

            console.log(`🔄 Unzipping database using System UNZIP (Memory Safe)...`);
            console.log(`   Source: ${DB_ZIP}`);
            console.log(`   Target: ${extractDir}`);

            // Using system unzip: -o (overwrite), -d (directory)
            // execSync blocks safely without OOMing the Node process
            try {
                execSync(`unzip -o "${DB_ZIP}" -d "${extractDir}"`, { stdio: 'inherit' });
                console.log(`✅ Database restored successfully to ${extractDir}`);
            } catch (err) {
                // Fallback if unzip missing? Unlikely if we updated Dockerfile.
                // But for local mac if unzip exists it works.
                console.error('❌ System unzip failed, falling back to AdmZip (Warning: High Memory)', err);
                const zip = new AdmZip(DB_ZIP);
                zip.extractAllTo(extractDir, true);
            }

        } catch (e) {
            console.error('❌ Failed to restore database:', e);
        }
    } else {
        console.log('✅ Database exists and looks healthy. No restore needed.');
    }
}

module.exports = restoreDatabase;
