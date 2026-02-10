const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

// Path to the master index
const INDEX_PATH = '/Users/admin/RAV_ABICHID_DB/INDEX/MASTER_INDEX_EXTENDED.json';
const EXTERNAL_DRIVE_PATH = '/Volumes/Samsung_T5';

let fileMap = null; // Name -> Original Path
let externalMap = null; // Name -> External Path
let isLoaded = false;
let isExternalScanning = false;

/**
 * Loads the index into memory. This is a heavy operation (~60MB JSON),
 * so it should be done once at startup.
 */
function loadIndex() {
    if (isLoaded) return;

    console.log('🔄 Loading RAV_ABICHID_DB Index...');
    try {
        if (!fs.existsSync(INDEX_PATH)) {
            console.warn('⚠️ RAV_ABICHID_DB Index not found at:', INDEX_PATH);
            fileMap = new Map();
            externalMap = new Map();
            isLoaded = true;
            scanExternalDrive(); // Still try to scan external if index is missing
            return;
        }

        const data = fs.readFileSync(INDEX_PATH, 'utf8');
        const json = JSON.parse(data);

        fileMap = new Map();

        if (json.files && Array.isArray(json.files)) {
            let count = 0;
            json.files.forEach(file => {
                if (file.name && file.path) {
                    fileMap.set(file.name, file.path);
                    count++;
                }
            });
            console.log(`✅ RAV_ABICHID_DB Index loaded: ${count} files mapped.`);
        } else {
            console.warn('⚠️ Invalid index format (missing files array).');
        }

        // Start external scan in background
        externalMap = new Map();
        scanExternalDrive();

    } catch (error) {
        console.error('❌ Failed to load RAV_ABICHID_DB Index:', error.message);
        fileMap = new Map();
        externalMap = new Map();
    } finally {
        isLoaded = true;
    }
}

/**
 * Scans the external drive for audio files in background
 */
function scanExternalDrive() {
    if (isExternalScanning || !fs.existsSync(EXTERNAL_DRIVE_PATH)) {
        if (!fs.existsSync(EXTERNAL_DRIVE_PATH)) console.log('ℹ️ No external drive detected at', EXTERNAL_DRIVE_PATH);
        return;
    }

    isExternalScanning = true;
    console.log(`🔄 Scanning external drive: ${EXTERNAL_DRIVE_PATH} ...`);

    // Use 'find' command to quickly locate media files
    // Find opus, ogg, mp3, m4a, wav
    const cmd = `find "${EXTERNAL_DRIVE_PATH}" -type f \\( -name "*.opus" -o -name "*.ogg" -o -name "*.mp3" -o -name "*.m4a" -o -name "*.wav" -o -name "*.jpg" \\) -maxdepth 8`;

    exec(cmd, { maxBuffer: 1024 * 1024 * 50 }, (error, stdout, stderr) => {
        isExternalScanning = false;
        if (error) {
            console.error(`❌ External scan error (partial results used): ${error.message}`);
        }

        if (stdout) {
            const lines = stdout.split('\n');
            let count = 0;
            lines.forEach(line => {
                const trimmed = line.trim();
                if (trimmed) {
                    const name = path.basename(trimmed);
                    // Prioritize shorter paths (likely root backups) or just overwrite
                    if (!externalMap.has(name)) {
                        externalMap.set(name, trimmed);
                        count++;
                    }
                }
            });
            console.log(`✅ External scan complete: ${count} files found on Samsung_T5.`);
        }
    });
}

/**
 * Finds the absolute path for a given filename.
 * @param {string} filename - The name of the file (e.g., 'audio.opus')
 * @returns {string|null} - The absolute path or null if not found
 */
function findFilePath(filename) {
    if (!isLoaded) loadIndex(); // Lazy load if not ready (but blocking!)

    // 1. Try Memory Map (Original Paths)
    // ONLY if file actually exists!
    if (fileMap && fileMap.has(filename)) {
        const originalPath = fileMap.get(filename);
        if (fs.existsSync(originalPath)) {
            return originalPath;
        }
    }

    // 2. Try External Map
    if (externalMap && externalMap.has(filename)) {
        const extPath = externalMap.get(filename);
        if (fs.existsSync(extPath)) {
            return extPath;
        }
    }

    return null;
}

module.exports = {
    loadIndex,
    findFilePath
};
