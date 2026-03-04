#!/bin/bash
# ==============================================================================
# Upload RavQA Audio Files to Backblaze B2
# Run once to upload all local MP3 files so Railway can serve them via CDN.
# ==============================================================================

set -e

BUCKET="rav-abichid-audio"
MEDIA_DIR="/Users/admin/rav-whatsapp-local/media"
B2_BIN="/usr/local/Cellar/b2-tools/4.6.0/bin/b2"

echo "🔐 Authenticating with Backblaze B2..."
if [ -z "$B2_KEY_ID" ] || [ -z "$B2_APP_KEY" ]; then
    echo "❌ Set B2_KEY_ID and B2_APP_KEY environment variables before running."
    echo "   Example: B2_KEY_ID=xxx B2_APP_KEY=yyy bash scripts/upload_to_b2.sh"
    exit 1
fi

$B2_BIN authorize-account "$B2_KEY_ID" "$B2_APP_KEY"

echo "🪣 Creating bucket '$BUCKET' (allPublic)..."
$B2_BIN create-bucket "$BUCKET" allPublic 2>/dev/null || echo "Bucket already exists, continuing..."

echo "📤 Syncing $MEDIA_DIR → b2://$BUCKET/"
echo "   (This will upload ~18,000 files, may take 30-60 minutes)"
$B2_BIN sync --threads 10 "$MEDIA_DIR/" "b2://$BUCKET/"

echo ""
echo "✅ Upload complete!"
echo ""
echo "📋 Add this to Railway environment variables:"
echo "   MEDIA_BASE_URL=https://f000.backblazeb2.com/file/$BUCKET"
echo ""
echo "Or get the exact URL from your Backblaze dashboard → Buckets → '$BUCKET' → Bucket Settings"
