import sys
import json
import requests
import time
from urllib.parse import quote

def fetch_crtsh(domain):
    url = f"https://crt.sh/?q=%25.{quote(domain)}&output=json"
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
        "Connection": "keep-alive",
        "Upgrade-Insecure-Requests": "1",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Sec-Fetch-User": "?1",
    }
    
    # Try a few times with backoff
    for attempt in range(3):
        try:
            response = requests.get(url, headers=headers, timeout=40)
            if response.status_code == 200:
                try:
                    return response.json()
                except:
                    # Sometimes it returns text even with output=json
                    if response.text.strip().startswith("["):
                        return json.loads(response.text)
                    return None
            elif response.status_code == 502:
                time.sleep(5 * (attempt + 1))
                continue
            else:
                print(f"Error: HTTP {response.status_code}", file=sys.stderr)
                return None
        except Exception as e:
            print(f"Error: {str(e)}", file=sys.stderr)
            time.sleep(2)
            
    return None

if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit(1)
    
    result = fetch_crtsh(sys.argv[1])
    if result:
        print(json.dumps(result))
    else:
        sys.exit(1)
