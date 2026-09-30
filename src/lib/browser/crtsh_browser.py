import sys
import json
import time
import requests
from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.chrome.service import Service

def fetch_crtsh_selenium(domain):
    chrome_options = Options()
    chrome_options.add_argument("--headless")
    chrome_options.add_argument("--no-sandbox")
    chrome_options.add_argument("--disable-dev-shm-usage")
    chrome_options.add_argument("--disable-gpu")
    chrome_options.add_argument("user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")

    # In many environments, the chromium executable is just 'chromium' or 'chromium-browser'
    chrome_options.binary_location = "/snap/bin/chromium" 

    try:
        # We try to use the system webdriver if available, or just hope selenium finds it
        driver = webdriver.Chrome(options=chrome_options)
        url = f"https://crt.sh/?q=%25.{domain}&output=json"
        driver.get(url)
        
        # Wait for content
        time.sleep(5)
        
        content = driver.page_source
        # crt.sh output=json is often just raw JSON in the body
        if "<html>" in content:
            # Extract from pre or body if it's wrapped in HTML
            from bs4 import BeautifulSoup
            soup = BeautifulSoup(content, 'html.parser')
            text = soup.get_text()
        else:
            text = content
            
        driver.quit()
        return json.loads(text)
    except Exception as e:
        print(f"Error: {str(e)}", file=sys.stderr)
        return None

if __name__ == "__main__":
    domain = sys.argv[1]
    res = fetch_crtsh_selenium(domain)
    if res:
        print(json.dumps(res))
