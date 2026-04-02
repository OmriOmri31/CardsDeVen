import os
import json
import time
from playwright.sync_api import sync_playwright
from playwright_stealth import Stealth
import firebase_admin
from firebase_admin import credentials, db

# Temporary local path for testing
cred = credentials.Certificate(r"C:\Users\iamam\OneDrive\Desktop\cardsdeven-firebase-adminsdk-fbsvc-dac77be72f.json") 
firebase_admin.initialize_app(cred, {
    'databaseURL': 'https://cardsdeven-default-rtdb.firebaseio.com/'
})

# Reference to your MacroDroid drop zone
otp_ref = db.reference('secret_otp_drop_zone_xyz123')

def get_new_otp(start_time, timeout_seconds=120):
    """Polls Firebase for a new OTP that arrived after the script started."""
    end_time = time.time() + timeout_seconds
    while time.time() < end_time:
        data = otp_ref.get()
        if data and 'timestamp' in data and 'code' in data:
            # MacroDroid saves timestamp in Unix seconds
            if int(data['timestamp']) > start_time:
                return data['code']
        time.sleep(5) # Wait 5 seconds before checking again
    raise Exception("Timeout waiting for OTP from MacroDroid")

def run_scraper():
    # Record when script starts so we only grab NEW text messages
    start_time = int(time.time())
    
    with sync_playwright() as p:
        # headless=True keeps it invisible
        browser = p.chromium.launch(headless=True)
        
        # Create a context that perfectly mimics a real Windows desktop browser
        context = browser.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
            viewport={"width": 1920, "height": 1080}
        )
        page = context.new_page()
        
        # INJECT STEALTH (v2.0+ Syntax): This patches the headless browser fingerprint
        stealth = Stealth()
        stealth.apply_stealth_sync(page)
        
        # 2. Navigate and Login
        print("Navigating to Behatsdaa...")
        page.goto("https://www.behatsdaa.org.il/login")
        
        # Enter ID
        print("Entering ID...")
        page.fill("#loginIdWithShortCode", "209056860") 
        
        # Click to trigger SMS
        print("Requesting SMS...")
        page.click("button:has-text('שלחו לי קוד חד פעמי לנייד ולמייל')") 
        
        print("Credentials submitted. Waiting for SMS...")
        
        # 3. Poll Firebase for the MacroDroid code
        print("Polling Firebase for OTP...")
        otp_code = get_new_otp(start_time)
        print(f"Received OTP ({otp_code})! Entering into browser...")
        
        # 4. Enter OTP
        page.fill("#shortCode", otp_code) 
        
        # 5. Final Submit
        page.click("button:has-text('התחברות')") 
        
        # Wait for the login to complete and dashboard to load
        print("Waiting for login to complete...")
        page.wait_for_load_state("networkidle") 
        print("Successfully logged in!")
        
        # 6. SCRAPING LOGIC
        # You will need to inspect the dashboard page and write the locators 
        # to grab the actual Hebrew text/prices of the sales you are eligible for.
        # Example placeholder:
        # card_titles = page.locator(".some-card-title-class").all_inner_texts()
        
        scraped_data = {
            "last_updated": time.strftime("%Y-%m-%d %H:%M:%S"),
            "discounts": [
                {"name": "Mock Discount", "value": "20%"} # Replace with real scraped data
            ]
        }
        
        # 7. Save to JSON (Ensuring Hebrew characters don't break)
        os.makedirs("public", exist_ok=True)
        with open("public/data.json", "w", encoding="utf-8") as f:
            json.dump(scraped_data, f, ensure_ascii=False, indent=4)
            
        print("Scraping complete. Data saved to public/data.json")
        browser.close()

if __name__ == "__main__":
    run_scraper()