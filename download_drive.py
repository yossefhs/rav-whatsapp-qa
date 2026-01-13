import sys
import os
import urllib.request
import urllib.parse
from http.cookiejar import CookieJar

def download_file_from_google_drive(id, destination):
    URL = "https://docs.google.com/uc?export=download"
    
    jar = CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    urllib.request.install_opener(opener)
    
    print(f"   1. Connecting to Google Drive (ID: {id})...")
    
    try:
        request = urllib.request.Request(
            URL + "?id=" + id,
            headers={"User-Agent": "Mozilla/5.0"}
        )
        with opener.open(request) as response:
            content = response.read()
            # If small content, it might be the confirmation page or direct file
            # But the 'download_warning' cookie is what we look for usually in headers
            
            # Check cookies for confirmation token
            confirm_token = None
            for cookie in jar:
                if cookie.name.startswith('download_warning'):
                    confirm_token = cookie.value
                    break
            
            if confirm_token:
                print(f"   🔑 Found confirmation token: {confirm_token}")
                params = {'id': id, 'confirm': confirm_token}
                confirm_url = URL + "?" + urllib.parse.urlencode(params)
                
                print("   2. Downloading large file...")
                with opener.open(confirm_url) as file_response:
                    with open(destination, "wb") as f:
                        while True:
                            chunk = file_response.read(32768)
                            if not chunk: break
                            f.write(chunk)
            else:
                # Maybe direct download or small file
                print("   ℹ️ Direct download (no confirmation needed)...")
                with open(destination, "wb") as f:
                    f.write(content) # Write what we already read
                    # Continue reading if there's more? No, response.read() reads all if no size logic
                    # CAREFUL: response.read() loads all in memory. 150MB is fine for Railway.
        
        print(f"   ✅ Download complete: {destination}")
        
    except Exception as e:
        print(f"   ❌ Error: {e}")
        sys.exit(1)

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python3 download_drive.py <file_id> <destination>")
        sys.exit(1)
        
    file_id = sys.argv[1]
    dest = sys.argv[2]
    download_file_from_google_drive(file_id, dest)
