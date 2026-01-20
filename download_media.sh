#!/bin/bash
# Download and extract media files on Railway startup using gdown (more reliable)

MEDIA_DIR="./media"
FILE_ID="1I2NtAlpRHBiHsSo4bppnKrHu8QKAbf4K"

# Create media directory if needed
mkdir -p "$MEDIA_DIR"

# Check if media already exists (persistent volume or previous run)
MP3_COUNT=$(find "$MEDIA_DIR" -name "*.mp3" 2>/dev/null | wc -l)
if [ "$MP3_COUNT" -gt 100 ]; then
    echo "✅ Media already exists ($MP3_COUNT MP3 files), skipping download"
    exit 0
fi

echo "⬇️  Installing gdown..."
# Try installing gdown. Allow break-system-packages for managed environments (Docker)
pip3 install gdown --break-system-packages || pip3 install gdown

echo "⬇️  Downloading media archive (ID: $FILE_ID)..."
# Use gdown to handle Google Drive large files automatically
gdown --id "$FILE_ID" -O ./media.zip

if [ ! -f "./media.zip" ]; then
    echo "❌ Download failed. File media.zip not found."
    exit 1
fi

echo "📦 Extracting media files..."
# -o: overwrite
# -j: junk paths (flatten)
unzip -o -j ./media.zip -d "$MEDIA_DIR" > /dev/null

# Clean up
rm ./media.zip

echo "✅ Media files extracted successfully"
