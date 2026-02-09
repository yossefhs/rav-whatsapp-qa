const fs = require('fs');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');
const AdmZip = require('adm-zip');

const MEDIA_DIR = path.join(__dirname, '../media');
const UPLOAD_URL = 'https://rav-whatsapp-qa-production.up.railway.app/api/debug/upload-media';
const BATCH_SIZE_MB = 20;

async function uploadRenamed() {
    console.log('🚀 Starting Renamed Audio Upload (import_*, wa_*)...');

    // Find all import_*.mp3 and wa_*.mp3 files
    const allFiles = fs.readdirSync(MEDIA_DIR);
    const targetFiles = allFiles.filter(f =>
        (f.startsWith('import_') || f.startsWith('wa_')) &&
        (f.endsWith('.mp3') || f.endsWith('.m4a'))
    );

    console.log(`📂 Found ${targetFiles.length} renamed audio files`);

    // Calculate total size
    let totalSize = 0;
    targetFiles.forEach(f => {
        const stats = fs.statSync(path.join(MEDIA_DIR, f));
        totalSize += stats.size;
    });
    console.log(`📏 Total size: ${(totalSize / 1024 / 1024).toFixed(2)} MB`);

    // Create batches
    const batches = [];
    let currentBatch = [];
    let currentSize = 0;
    const maxSize = BATCH_SIZE_MB * 1024 * 1024;

    for (const file of targetFiles) {
        const filePath = path.join(MEDIA_DIR, file);
        const stats = fs.statSync(filePath);

        if (currentSize + stats.size > maxSize && currentBatch.length > 0) {
            batches.push([...currentBatch]);
            currentBatch = [];
            currentSize = 0;
        }

        currentBatch.push(file);
        currentSize += stats.size;
    }

    if (currentBatch.length > 0) {
        batches.push(currentBatch);
    }

    console.log(`📦 Created ${batches.length} batches\n`);

    // Upload each batch starting from batch 91 (index 90)
    for (let i = 90; i < batches.length; i++) {
        const batch = batches[i];
        const batchSize = batch.reduce((sum, f) => {
            return sum + fs.statSync(path.join(MEDIA_DIR, f)).size;
        }, 0);

        console.log(`📦 Zipping Batch ${i + 1} (${batch.length} files, ${(batchSize / 1024 / 1024).toFixed(2)} MB)...`);

        // Create ZIP
        const zip = new AdmZip();
        batch.forEach(file => {
            zip.addLocalFile(path.join(MEDIA_DIR, file));
        });

        const zipBuffer = zip.toBuffer();
        const zipPath = `/tmp/batch_renamed_${i + 1}.zip`;
        fs.writeFileSync(zipPath, zipBuffer);

        console.log(`🚀 Uploading Batch ${i + 1}...`);

        try {
            const form = new FormData();
            form.append('file', fs.createReadStream(zipPath));

            const https = require('https');
            const httpsAgent = new https.Agent({ rejectUnauthorized: false });

            const response = await axios.post(UPLOAD_URL, form, {
                headers: form.getHeaders(),
                httpsAgent,
                maxContentLength: Infinity,
                maxBodyLength: Infinity,
                timeout: 120000
            });

            console.log(`✅ Batch ${i + 1} Done:`, response.data);
            fs.unlinkSync(zipPath);
        } catch (error) {
            console.error(`❌ Batch ${i + 1} Failed:`, error.message);
            if (error.response) {
                console.error('Response:', error.response.data);
            }
        }

        console.log('');
    }

    console.log('✅ Upload Complete!');
}

uploadRenamed().catch(console.error);
