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

# Download using Python script (more reliable for Google Drive cookies)
echo "📥 Downloading media files using Python script..."

if [ ! -f "download_drive.py" ]; then
    echo "❌ Error: download_drive.py not found"
    exit 1
fi

python3 download_drive.py "$FILE_ID" "/tmp/media.zip"

if [ $? -ne 0 ]; then
    echo "❌ Python script failed"
    exit 1
fi

echo "📦 Extracting media files..."
# Install unzip if missing
if ! command -v unzip &> /dev/null; then
    echo "   Installing unzip..."
    apt-get update && apt-get install -y unzip
fi

unzip -o /tmp/media.zip -d "$MEDIA_DIR" > /dev/null
rm /tmp/media.zip
echo "✅ Media files extracted successfully"
