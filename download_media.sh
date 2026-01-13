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

# Download from Google Drive with improved logic
COOKIE_FILE="/tmp/gcookie"
RESPONSE_FILE="/tmp/gresponse"

echo "   1. Fetching confirmation token..."
# Get the page/cookie
curl -c "$COOKIE_FILE" -L "https://drive.google.com/uc?export=download&id=${FILE_ID}" > "$RESPONSE_FILE" 2>/dev/null

# Extract confirmation code (robust grep)
CONFIRM=$(grep -o 'confirm=[0-9A-Za-z_]*' "$RESPONSE_FILE" | cut -d= -f2 | head -n1)

URL="https://drive.google.com/uc?export=download&id=${FILE_ID}"
if [ -n "$CONFIRM" ]; then
    echo "   🔑 Found confirmation token: $CONFIRM"
    URL="${URL}&confirm=${CONFIRM}"
else
    echo "   ℹ️ No confirmation token found (file might be small or direct download)"
fi

echo "   2. Downloading binary..."
curl -Lb "$COOKIE_FILE" "$URL" -o /tmp/media.zip

echo "   3. Verifying download..."
# Check size > 10KB
FILESIZE=$(stat -c%s "/tmp/media.zip" 2>/dev/null || stat -f%z "/tmp/media.zip")
if [ "$FILESIZE" -lt 10000 ]; then
    echo "❌ Downloaded file is too small ($FILESIZE bytes). Content:"
    cat /tmp/media.zip
    exit 1
fi

echo "📦 Extracting media files..."
# Install unzip if missing
if ! command -v unzip &> /dev/null; then
    echo "   Installing unzip..."
    apt-get update && apt-get install -y unzip
fi

unzip -o /tmp/media.zip -d "$MEDIA_DIR"
rm /tmp/media.zip "$COOKIE_FILE" "$RESPONSE_FILE"
echo "✅ Media files extracted successfully"
