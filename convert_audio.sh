#!/bin/bash
# Convert OGG audio files to MP3 for iOS compatibility

MEDIA_DIR="./media"
CONVERTED=0
FAILED=0
TOTAL=$(find "$MEDIA_DIR" -name "*.ogg" | wc -l | tr -d ' ')

echo "🎵 Converting OGG files to MP3..."
echo "📁 Directory: $MEDIA_DIR"
echo "📊 Total OGG files: $TOTAL"
echo ""

# Check if ffmpeg is installed
if ! command -v ffmpeg &> /dev/null; then
    echo "❌ ffmpeg is not installed. Install with: brew install ffmpeg"
    exit 1
fi

# Convert each OGG file to MP3
for ogg_file in "$MEDIA_DIR"/*.ogg; do
    if [ -f "$ogg_file" ]; then
        mp3_file="${ogg_file%.ogg}.mp3"
        
        # Skip if MP3 already exists
        if [ -f "$mp3_file" ]; then
            echo "⏭️  Skipping (exists): $(basename "$mp3_file")"
            continue
        fi
        
        echo "🔄 Converting: $(basename "$ogg_file")"
        
        # Convert with ffmpeg (quiet mode, good quality)
        if ffmpeg -i "$ogg_file" -codec:a libmp3lame -qscale:a 2 "$mp3_file" -y -loglevel error 2>/dev/null; then
            ((CONVERTED++))
            echo "   ✅ Done: $(basename "$mp3_file")"
        else
            ((FAILED++))
            echo "   ❌ Failed: $(basename "$ogg_file")"
        fi
    fi
done

echo ""
echo "========================================="
echo "📊 Conversion Complete!"
echo "   ✅ Converted: $CONVERTED"
echo "   ❌ Failed: $FAILED"
echo "   📁 Total MP3 files now available"
echo "========================================="
