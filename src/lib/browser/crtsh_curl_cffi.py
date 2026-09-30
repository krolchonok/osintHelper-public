import sys
import json
from curl_cffi import requests
from urllib.parse import quote

def fetch_crtsh_cffi(domain):
    url = f"https://crt.sh/?q=%25.{quote(domain)}&output=json"
    try:
        # impersonate="chrome" will set browser-like TLS fingerprint and headers
        response = requests.get(url, impersonate="chrome120", timeout=40)
        if response.status_code == 200:
            return response.json()
        else:
            print(f"Error: HTTP {response.status_code}", file=sys.stderr)
            return None
    except Exception as e:
        print(f"Error: {str(e)}", file=sys.stderr)
        return None

if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit(1)
    domain = sys.argv[1]
    res = fetch_crtsh_cffi(domain)
    if res:
        print(json.dumps(res))
    else:
        sys.exit(1)
