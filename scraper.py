import os
import json
import time
import sys
import subprocess
from playwright.sync_api import sync_playwright
from playwright_stealth import Stealth
import firebase_admin
from firebase_admin import credentials, db

# ==========================================
# 1. CONFIGURATION & INITIALIZATION
# ==========================================

FIREBASE_KEY_PATH = r"C:\Users\iamam\OneDrive\Desktop\cardsdeven-firebase-adminsdk-fbsvc-dac77be72f.json"
BEHATSDAA_ID = "209056860"
DATABASE_URL = 'https://cardsdeven-default-rtdb.firebaseio.com/'

if not firebase_admin._apps:
    cred = credentials.Certificate(FIREBASE_KEY_PATH)
    firebase_admin.initialize_app(cred, {
        'databaseURL': DATABASE_URL
    })

otp_ref = db.reference('secret_otp_drop_zone_xyz123')

TARGET_URLS = [
    "https://www.behatsdaa.org.il/", 
    "https://www.behatsdaa.org.il/category/products/99584",
    "https://www.behatsdaa.org.il/category/products/44082",
    "https://www.behatsdaa.org.il/category/products/4625",
    "https://www.behatsdaa.org.il/category/products/68807",
    "https://www.behatsdaa.org.il/category/products/1158",
    "https://www.behatsdaa.org.il/category/products/150690",
    "https://www.behatsdaa.org.il/category/products/162210",
    "https://www.behatsdaa.org.il/category/products/163454",
    "https://www.behatsdaa.org.il/category/products/22790",
    "https://www.behatsdaa.org.il/category/products/11837",
    "https://www.behatsdaa.org.il/category/products/23553",
    "https://www.behatsdaa.org.il/category/productPage/135619",
    "https://www.behatsdaa.org.il/category/products/13007",
    "https://www.behatsdaa.org.il/category/products/39878",
    "https://www.behatsdaa.org.il/category/products/6982",
    "https://www.behatsdaa.org.il/category/products/65892",
    "https://www.behatsdaa.org.il/category/products/21521",
    "https://www.behatsdaa.org.il/category/products/26011",
    "https://www.behatsdaa.org.il/category/products/39883",
    "https://www.behatsdaa.org.il/category/products/44004",
    "https://www.behatsdaa.org.il/category/products/39880",
    "https://www.behatsdaa.org.il/category/products/8848",
    "https://www.behatsdaa.org.il/category/products/39911",
    "https://www.behatsdaa.org.il/category/products/172523",
    "https://www.behatsdaa.org.il/category/products/43987",
    "https://www.behatsdaa.org.il/category/products/9318",
    "https://www.behatsdaa.org.il/category/products/110091",
    "https://www.behatsdaa.org.il/category/products/43988",
    "https://www.behatsdaa.org.il/category/products/152160"
]

# ==========================================
# 2. HELPER FUNCTIONS
# ==========================================

def get_new_otp(start_time, timeout_seconds=120):
    end_time = time.time() + timeout_seconds
    print(f"Polling Firebase for OTP (Timeout: {timeout_seconds}s)...")
    while time.time() < end_time:
        data = otp_ref.get()
        if data and 'timestamp' in data and 'code' in data:
            if int(data['timestamp']) > start_time:
                return data['code']
        time.sleep(5) 
    raise Exception("Timeout: No new OTP received.")

def push_to_github():
    print("--- Git Automation Started ---")
    try:
        subprocess.run(["git", "add", "public/data.json"], check=True)
        commit_msg = f"auto-scrape: {time.strftime('%Y-%m-%d %H:%M:%S')}"
        subprocess.run(["git", "commit", "-m", commit_msg], check=True)
        subprocess.run(["git", "push"], check=True)
        print("Successfully pushed to GitHub!")
    except subprocess.CalledProcessError as e:
        print(f"Git Update Skipped: No changes to push or network issue. ({e})")
    except FileNotFoundError:
        print("Git is not installed or not in PATH. Skipping push.")
    print("------------------------------")

def get_page_topic(page):
    try:
        page.wait_for_selector(".bread-crumbs-container", timeout=3000)
        crumbs = page.locator(".bread-crumbs-container .single-crumb-container a span").all_inner_texts()
        if crumbs and len(crumbs) > 1:
            return crumbs[-1].strip()
    except Exception:
        pass
    return "כללי"

# ==========================================
# 3. PAGE SCRAPING LOGIC
# ==========================================

def scrape_page_data(page, url, master_data):
    print(f"\nScanning: {url}")
    try:
        page.goto(url, wait_until="networkidle", timeout=45000)
    except Exception as e:
        print(f"Skipping {url} - Failed to load: {e}")
        return

    # Verify Home Page
    if url == "https://www.behatsdaa.org.il/":
        try:
            page.wait_for_selector('img.logo-item.cursor-pointer[alt="לוגו בהצדעה"]', timeout=5000)
            print("Home page verified.")
        except Exception:
            pass

    topic = get_page_topic(page)
    if topic not in master_data:
        master_data[topic] = {}

    # Extract Data (Skipping the Load More button entirely)
    try:
        # Give the page 3 seconds to render the cards before looking for them
        page.wait_for_timeout(3000)
        
        cards = page.locator(".categories-container-item").all()
        print(f"Found {len(cards)} sales on this page.")
        
        for card in cards:
            try:
                title = card.locator(".categories-container-item-header .medium-font").inner_text(timeout=1000).strip()
                price = card.locator(".categories-container-item-price .price-text").inner_text(timeout=1000).strip()
                address = card.locator(".categories-container-item-location .location-name-text").inner_text(timeout=1000).strip()
                
                img_locator = card.locator(".categories-container-item-img").first
                company = img_locator.get_attribute("title", timeout=1000)
                if not company:
                    company = img_locator.get_attribute("alt", timeout=1000)
                
                company = company.strip() if company else ""
                
                if not company or len(company) > 30:
                    company = topic
                
                if company not in master_data[topic]:
                    master_data[topic][company] = []
                
                sale_item = {
                    "title": title,
                    "price": price,
                    "address": address
                }
                
                if sale_item not in master_data[topic][company]:
                    master_data[topic][company].append(sale_item)

            except Exception:
                continue
                
    except Exception as e:
        print(f"Error reading cards on {url}: {e}")

# ==========================================
# 4. MAIN EXECUTOR
# ==========================================

def run_scraper(headless_mode=True):
    start_time = int(time.time())
    print(f"Starting Scraper in {'HEADLESS' if headless_mode else 'VISIBLE'} mode...")

    all_scraped_data = {}

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=headless_mode)
        context = browser.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
            viewport={"width": 1920, "height": 1080}
        )
        page = context.new_page()
        Stealth().apply_stealth_sync(page)

        try:
            # Login Flow
            print("Navigating to Behatsdaa...")
            page.goto("https://www.behatsdaa.org.il/login", wait_until="networkidle")
            
            print("Entering ID...")
            page.fill("#loginIdWithShortCode", BEHATSDAA_ID) 
            
            print("Requesting SMS...")
            page.click("button:has-text('שלחו לי קוד חד פעמי לנייד ולמייל')") 
            
            print("Credentials submitted. Waiting for SMS...")
            otp_code = get_new_otp(start_time)
            
            print(f"Received OTP ({otp_code})! Entering into browser...")
            page.fill("#shortCode", otp_code) 
            page.click("button:has-text('התחברות')") 
            
            print("Waiting for login redirect to complete...")
            page.wait_for_timeout(5000) 
            page.wait_for_load_state("networkidle") 
            print("Login Successful!")

            # Scrape Pages
            for url in TARGET_URLS:
                scrape_page_data(page, url, all_scraped_data)

            # Build and Save JSON
            final_json = {
                "last_updated": time.strftime("%Y-%m-%d %H:%M:%S"),
                "data": all_scraped_data
            }

            os.makedirs("public", exist_ok=True)
            with open("public/data.json", "w", encoding="utf-8") as f:
                json.dump(final_json, f, ensure_ascii=False, indent=4)
            print("\nScraping complete. Data saved to public/data.json.")

        except Exception as e:
            print(f"A critical error occurred: {e}")
        finally:
            browser.close()
            push_to_github()

if __name__ == "__main__":
    should_be_visible = "--visible" in sys.argv
    run_scraper(headless_mode=not should_be_visible)