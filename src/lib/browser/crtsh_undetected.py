import sys
import json
import time
import undetected_chromedriver as uc
from selenium.webdriver.common.by import By

def fetch_crtsh_undetected(domain):
    options = uc.ChromeOptions()
    options.add_argument("--headless")
    options.add_argument("--no-sandbox")
    options.add_argument("--disable-dev-shm-usage")
    # path to chromium
    options.binary_location = "/snap/bin/chromium"
    
    try:
        driver = uc.Chrome(options=options)
        url = f"https://crt.sh/?q=%25.{domain}&output=json"
        driver.get(url)
        
        # Wait for data or some time
        time.sleep(10)
        
        # In crt.sh output=json, the response is often just the text in the pre tag or body
        body = driver.find_element(By.TAG_NAME, "body").text
        
        driver.quit()
        
        # Clean up potential HTML if it's not raw JSON
        if body.strip().startswith("["):
            return json.loads(body)
        else:
            # Fallback if it's wrapped
            start = body.find("[")
            end = body.rfind("]")
            if start != -1 and end != -1:
                return json.loads(body[start:end+1])
        return None
    except Exception as e:
        print(f"Error: {str(e)}", file=sys.stderr)
        return None

if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit(1)
    domain = sys.argv[1]
    res = fetch_crtsh_undetected(domain)
    if res:
        print(json.dumps(res))
    else:
        sys.exit(1)
