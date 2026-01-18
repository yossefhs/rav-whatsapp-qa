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

# Download from Google Drive with robust HTML scraping (no python deps needed)
COOKIE_FILE="/tmp/gcookie"
TEMP_FILE="/tmp/gresponse"
FINAL_FILE="/tmp/media.zip"

echo "   1. Initial request to check for warning..."
# Clean up
rm -f "$COOKIE_FILE" "$TEMP_FILE" "$FINAL_FILE"

# Get the page/file
curl -c "$COOKIE_FILE" -L "https://drive.google.com/uc?export=download&id=${FILE_ID}" -o "$TEMP_FILE"

# Check if it's the warning page
if grep -q "Virus scan warning" "$TEMP_FILE"; then
    echo "   ⚠️ Large file warning detected. Scraping confirmation parameters..."
    
    # Extract parameters using grep/cut (robust)
    UUID=$(grep -o 'name="uuid" value="[^"]*"' "$TEMP_FILE" | cut -d'"' -f4 | head -n1)
    CONFIRM=$(grep -o 'name="confirm" value="[^"]*"' "$TEMP_FILE" | cut -d'"' -f4 | head -n1)
    ACTION=$(grep -o 'action="[^"]*"' "$TEMP_FILE" | cut -d'"' -f2 | head -n1)
    
    # Handle HTML entities in action URL just in case
    ACTION=$(echo "$ACTION" | sed 's/&amp;/\&/g')
    
    if [ -n "$UUID" ] && [ -n "$CONFIRM" ] && [ -n "$ACTION" ]; then
        echo "   🔑 Confirm: $CONFIRM, UUID: $UUID"
        echo "   🔗 Following link to: $ACTION"
        
        # Construct full URL
        # Note: We append params. explicit ? might be needed if ACTION doesn't have it
        if [[ "$ACTION" == *"?"* ]]; then
            FULL_URL="${ACTION}&id=${FILE_ID}&export=download&confirm=${CONFIRM}&uuid=${UUID}"
        else
            FULL_URL="${ACTION}?id=${FILE_ID}&export=download&confirm=${CONFIRM}&uuid=${UUID}"
        fi
        
        echo "   2. Downloading binary (large file)..."
        curl -L --retry 3 --retry-delay 5 --connect-timeout 60 --max-time 1800 -b "$COOKIE_FILE" "$FULL_URL" -o "$FINAL_FILE"
    else
        echo "❌ Failed to scrape parameters from warning page."
        cat "$TEMP_FILE"
        exit 1
    fi
else
    echo "   ℹ️ Direct download received."
    mv "$TEMP_FILE" "$FINAL_FILE"
fi

echo "   3. Verifying download..."
# Check size > 100MB (Audio zip is ~6.8GB)
FILESIZE=$(stat -c%s "$FINAL_FILE" 2>/dev/null || stat -f%z "$FINAL_FILE")
if [ "$FILESIZE" -lt 100000000 ]; then
    echo "⚠️ Warning: Downloaded file is too small ($FILESIZE bytes). Google Drive Quota might be exceeded."
    echo "⚠️ Proceeding without new media files to ensure server startup."
    # Log the error page for debug
    head -n 20 "$FINAL_FILE"
    rm "$FINAL_FILE"
    # DO NOT FAIL. Exit 0 to allow server to start.
    exit 0
fi

# Unzip (unzip is installed via Dockerfile)
echo "📦 Extracting media files..."
unzip -o -j "$FINAL_FILE" -d "$MEDIA_DIR" > /dev/null
rm "$FINAL_FILE"
echo "✅ Media files extracted successfully"
