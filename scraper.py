import os
import json
import time
import sys
import subprocess
from playwright.sync_api import sync_playwright
from playwright_stealth import Stealth
import firebase_admin
from firebase_admin import credentials, db
from google import genai
from google.genai import types
from dotenv import load_dotenv


# ==========================================
# 1. CONFIGURATION & INITIALIZATION
# ==========================================

FIREBASE_KEY_PATH = r"C:\Users\iamam\OneDrive\Desktop\cardsdeven-firebase-adminsdk-fbsvc-dac77be72f.json"
BEHATSDAA_ID = "209056860"
DATABASE_URL = 'https://cardsdeven-default-rtdb.firebaseio.com/'

# Use the API key from your React app for the embeddings
# Load hidden variables from .env
load_dotenv()

# Securely fetch the key
api_key = os.environ.get("GEMINI_API_KEY")
if not api_key:
    raise ValueError("GEMINI_API_KEY not found in .env file!")
genai.configure(api_key=api_key)

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
        subprocess.run(["git", "add", "cardsdeven/public/data.json"], check=True)
        commit_msg = f"auto-scrape: {time.strftime('%Y-%m-%d %H:%M:%S')}"
        subprocess.run(["git", "commit", "-m", commit_msg], check=True)
        
        print("Pulling latest changes from GitHub...")
        subprocess.run(["git", "pull", "--rebase"], check=True)
        
        print("Pushing to GitHub...")
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

def categorize_and_route(breadcrumb_topic, image_text, title, address):
    STANDUP_VENUES = ["COMY", "קאמל קומדי קלאב", "סטנדאפ פקטורי"]
    MUSIC_VENUES = ["זאפה", "מועדון גריי", "גריי", "ברלה", "רידינג 3", "בארבי", "שוני", "קו רקיע"]
    STANDUP_KEYWORDS = ["סטנדאפ", "סטנד אפ", "סטנד-אפ", "קומדיה", "מופע בידור", "מצחיק", "צחוק", "קורע", 
                        "חסון", "נוסבאום", "קוריאט", "קפח", "אשכנזי", "יצחקי", "ברוך"]
    
    venue = breadcrumb_topic
    if venue in ["בידור וסטנד אפ", "מופעים", "מופעים והצגות", "כללי", "אטרקציות", ""]:
        venue = "כללי / מיקומים שונים"
        
    if venue == "כללי / מיקומים שונים":
        for v in STANDUP_VENUES + MUSIC_VENUES:
            if v in address or v in title:
                venue = v
                break

    check_string = f"{breadcrumb_topic} {image_text} {title}".lower()
    master_category = breadcrumb_topic if breadcrumb_topic else "כללי"

    if any(v in venue for v in STANDUP_VENUES) or any(k in check_string for k in STANDUP_KEYWORDS):
        master_category = "בידור וסטנד אפ"
    elif any(v in venue for v in MUSIC_VENUES) or "מופע" in check_string or "מחווה" in check_string:
        master_category = "מופעים ומוזיקה"
    elif breadcrumb_topic in ["מופעים", "מופעים והצגות"]:
        master_category = "מופעים ומוזיקה"
        
    show_name = image_text.strip() if image_text and len(image_text) <= 40 else title.strip()
    if not show_name:
        show_name = "כללי"

    return master_category, venue, show_name

# ==========================================
# 3. AI EMBEDDING GENERATOR
# ==========================================

def generate_embeddings(nested_data):
    """Turns all scraped deals into mathematical vectors for instant AI searching."""
    print("\n--- Generating AI Search Vectors ---")
    flat_deals = []
    
    # Flatten the data for embedding
    for category, venues in nested_data.items():
        for venue, shows in venues.items():
            for show_name, deals in shows.items():
                for deal in deals:
                    search_string = f"[{category}] {venue} - {show_name}: {deal['title']} ({deal['price']}) at {deal['address']}"
                    flat_deals.append({
                        "m": venue,
                        "c": "BEHATSDAA",
                        "d": f"{deal['title']} ({deal['price']})",
                        "search_text": search_string
                    })
    
    print(f"Total deals to embed: {len(flat_deals)}")
    
    # Batch request embeddings from Google (100 at a time to be safe)
    batch_size = 100
    vectorized_deals = []
    
    for i in range(0, len(flat_deals), batch_size):
        batch = flat_deals[i:i+batch_size]
        texts = [item['search_text'] for item in batch]
        
        print(f"Embedding batch {i} to {i+len(batch)}...")
        try:
            response = genai.embed_content(
                model="models/gemini-embedding-001",
                content=texts,
                task_type="retrieval_document"
            )
            
            for j, embedding in enumerate(response['embedding']):
                deal = batch[j]
                vectorized_deals.append({
                    "m": deal["m"],
                    "c": deal["c"],
                    "d": deal["d"],
                    "v": embedding # The mathematical vector
                })
        except Exception as e:
            print(f"Failed to embed batch: {e}")
            
    print("Vector generation complete!")
    return vectorized_deals

# ==========================================
# 4. PAGE SCRAPING LOGIC
# ==========================================

def scrape_page_data(page, url, master_data):
    print(f"\nScanning: {url}")
    try:
        page.goto(url, wait_until="networkidle", timeout=45000)
    except Exception as e:
        print(f"Skipping {url} - Failed to load: {e}")
        return

    if url == "https://www.behatsdaa.org.il/":
        try:
            page.wait_for_selector('img.logo-item.cursor-pointer[alt="לוגו בהצדעה"]', timeout=5000)
            print("Home page verified.")
        except Exception:
            pass

    topic = get_page_topic(page)

    try:
        page.wait_for_timeout(3000)
        cards = page.locator(".categories-container-item").all()
        print(f"Found {len(cards)} sales on this page.")
        
        for card in cards:
            try:
                title = card.locator(".categories-container-item-header .medium-font").inner_text(timeout=1000).strip()
                price = card.locator(".categories-container-item-price .price-text").inner_text(timeout=1000).strip()
                address = card.locator(".categories-container-item-location .location-name-text").inner_text(timeout=1000).strip()
                
                img_locator = card.locator(".categories-container-item-img").first
                image_text = img_locator.get_attribute("title", timeout=1000)
                if not image_text:
                    image_text = img_locator.get_attribute("alt", timeout=1000)
                
                image_text = image_text.strip() if image_text else ""
                master_category, venue, show_name = categorize_and_route(topic, image_text, title, address)
                
                if master_category not in master_data:
                    master_data[master_category] = {}
                if venue not in master_data[master_category]:
                    master_data[master_category][venue] = {}
                if show_name not in master_data[master_category][venue]:
                    master_data[master_category][venue][show_name] = []
                
                sale_item = {
                    "title": title,
                    "price": price,
                    "address": address
                }
                
                if sale_item not in master_data[master_category][venue][show_name]:
                    master_data[master_category][venue][show_name].append(sale_item)

            except Exception:
                continue
                
    except Exception as e:
        print(f"Error reading cards on {url}: {e}")

# ==========================================
# 5. MAIN EXECUTOR
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
            print("Navigating to Behatsdaa...")
            page.goto("https://www.behatsdaa.org.il/login", wait_until="networkidle")
            page.fill("#loginIdWithShortCode", BEHATSDAA_ID) 
            page.click("button:has-text('שלחו לי קוד חד פעמי לנייד ולמייל')") 
            
            otp_code = get_new_otp(start_time)
            page.wait_for_selector("#shortCode", state="visible")
            page.locator("#shortCode").press_sequentially(otp_code, delay=150)
            page.wait_for_timeout(500)
            page.click("button:has-text('התחברות')") 
            
            page.wait_for_timeout(5000) 
            page.wait_for_load_state("networkidle") 

            for url in TARGET_URLS:
                scrape_page_data(page, url, all_scraped_data)

            # Generate the math vectors for AI Search
            vector_deals = generate_embeddings(all_scraped_data)

            final_json = {
                "last_updated": time.strftime("%Y-%m-%d %H:%M:%S"),
                "data": all_scraped_data,
                "vectors": vector_deals # Saving the math data into the same file
            }

            os.makedirs("cardsdeven/public", exist_ok=True)
            with open("cardsdeven/public/data.json", "w", encoding="utf-8") as f:
                json.dump(final_json, f, ensure_ascii=False, indent=4)
            print("\nScraping complete. Data saved to cardsdeven/public/data.json.")

        except Exception as e:
            print(f"A critical error occurred: {e}")
        finally:
            browser.close()
            push_to_github()

if __name__ == "__main__":
    should_be_visible = "--visible" in sys.argv
    run_scraper(headless_mode=not should_be_visible)