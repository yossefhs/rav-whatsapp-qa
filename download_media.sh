#!/bin/bash
# Download and extract media files on Railway startup

MEDIA_DIR="./media"
# Hardcoded Google Drive ID from user
FILE_ID="1I2NtAlpRHBiHsSo4bppnKrHu8QKAbf4K"

# Create media directory if needed
mkdir -p "$MEDIA_DIR"

# Check if media already exists (persistent volume)
MP3_COUNT=$(find "$MEDIA_DIR" -name "*.mp3" 2>/dev/null | wc -l)
if [ "$MP3_COUNT" -gt 100 ]; then
    echo "✅ Media already exists ($MP3_COUNT MP3 files), skipping download"
    exit 0
fi

echo "📥 Downloading media files from Google Drive (ID: $FILE_ID)..."

# Download from Google Drive with confirmation for large files
CONFIRM=$(curl -sc /tmp/gcookie "https://drive.google.com/uc?export=download&id=${FILE_ID}" | sed -rn 's/.*confirm=([0-9A-Za-z_]+).*/\1\n/p')
curl -Lb /tmp/gcookie "https://drive.google.com/uc?export=download&confirm=${CONFIRM}&id=${FILE_ID}" -o /tmp/media.zip

if [ -f "/tmp/media.zip" ] && [ -s "/tmp/media.zip" ]; then
    echo "📦 Extracting media files..."
    # Install unzip if missing (Railway image might need it)
    if ! command -v unzip &> /dev/null; then
        echo "Installing unzip..."
        apt-get update && apt-get install -y unzip
    fi
    
    unzip -o /tmp/media.zip -d "$MEDIA_DIR"
    rm /tmp/media.zip
    echo "✅ Media files extracted successfully"
else
    echo "❌ Failed to download media files"
    ls -l /tmp/media.zip
    cat /tmp/media.zip # Check if it's an HTML error page
    exit 1
fi
