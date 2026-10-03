import os
import json
import time
import sys
import subprocess
import hashlib
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

_REPO_ROOT = os.path.dirname(os.path.abspath(__file__))
BEHATSDAA_ORIGIN = "https://www.behatsdaa.org.il"
DATA_JSON_PATH = os.path.join(_REPO_ROOT, "cardsdeven", "public", "data.json")
# Gemini: max 100 texts per embed_content call; incremental cache to save daily quota.
_EMBED_BATCH = min(100, max(1, int(os.environ.get("BEHATSDAA_EMBED_BATCH_SIZE", "100"))))
_EMBED_SLEEP = max(0.0, float(os.environ.get("BEHATSDAA_EMBED_SLEEP_SEC", "2")))
# Listing cards often use JS navigation (no href). Click + capture URL; set BEHATSDAA_SKIP_URL_CLICKES=1 to skip (faster, urls empty).

# Load .env from repo root and from cardsdeven/ (GEMINI_API_KEY, BEHATSDAA_ID, etc.)
load_dotenv(os.path.join(_REPO_ROOT, '.env'))
load_dotenv(os.path.join(_REPO_ROOT, 'cardsdeven', '.env'))


def _init_firebase_admin() -> None:
    if firebase_admin._apps:
        return
    database_url = os.environ.get('FIREBASE_DATABASE_URL', '').strip()
    if not database_url:
        raise ValueError(
            'FIREBASE_DATABASE_URL is not set. Use your Realtime Database URL '
            '(e.g. https://<project>-default-rtdb.firebaseio.com/).'
        )
    json_str = os.environ.get('FIREBASE_SERVICE_ACCOUNT', '').strip()
    path = (
        os.environ.get('FIREBASE_SERVICE_ACCOUNT_PATH', '').strip()
        or os.environ.get('GOOGLE_APPLICATION_CREDENTIALS', '').strip()
    )
    if json_str:
        cred = credentials.Certificate(json.loads(json_str))
    elif path:
        cred = credentials.Certificate(os.path.expanduser(path))
    else:
        raise ValueError(
            'Firebase Admin credentials missing. Set FIREBASE_SERVICE_ACCOUNT (JSON string, e.g. in CI) '
            'or FIREBASE_SERVICE_ACCOUNT_PATH / GOOGLE_APPLICATION_CREDENTIALS (path to service account file).'
        )
    firebase_admin.initialize_app(cred, {'databaseURL': database_url})

BEHATSDAA_ID = os.environ.get('BEHATSDAA_ID', '').strip()
if not BEHATSDAA_ID:
    raise ValueError(
        'BEHATSDAA_ID is not set. Add it to .env or cardsdeven/.env, '
        'or export it in the shell (GitHub Actions: repository secret BEHATSDAA_ID).'
    )

api_key = os.environ.get("GEMINI_API_KEY")
if not api_key:
    raise ValueError("GEMINI_API_KEY not found! Set it in .env or cardsdeven/.env.")
client = genai.Client(api_key=api_key)

_init_firebase_admin()
_otp_path = os.environ.get('FIREBASE_OTP_REF', 'secret_otp_drop_zone_xyz123').strip() or 'secret_otp_drop_zone_xyz123'
otp_ref = db.reference(_otp_path)

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
    if os.environ.get("SKIP_GIT_PUSH", "").strip().lower() in ("1", "true", "yes"):
        print("SKIP_GIT_PUSH set; skipping git add/commit/push.")
        return
    try:
        # Ship slim JSON only; full data.json stays local (embeddings cache).
        to_add = [
            rel
            for rel in ("cardsdeven/public/behatsdaa_deals.json",)
            if os.path.isfile(os.path.join(_REPO_ROOT, rel))
        ]
        if not to_add:
            print("No scrape output files to commit.")
            return
        subprocess.run(["git", "add", "--"] + to_add, check=True, cwd=_REPO_ROOT)
        commit_msg = f"auto-scrape: {time.strftime('%Y-%m-%d %H:%M:%S')}"
        subprocess.run(["git", "commit", "-m", commit_msg], check=True, cwd=_REPO_ROOT)
        
        print("Pulling latest changes from GitHub...")
        subprocess.run(["git", "pull", "--rebase"], check=True, cwd=_REPO_ROOT)
        
        print("Pushing to GitHub...")
        subprocess.run(["git", "push"], check=True, cwd=_REPO_ROOT)
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

def flatten_behatsdaa_deals_for_app(nested_data):
    """Compact list for the web app (avoid shipping full data.json with vectors)."""
    flat = []
    seq = 0
    for category, venues in nested_data.items():
        for venue, shows in venues.items():
            for show_name, deals in shows.items():
                for deal in deals:
                    title = deal.get("title") or ""
                    price = deal.get("price") or ""
                    url = (deal.get("url") or "").strip()
                    base = " ".join(f"{title} ({price})".split()).strip()
                    sn = (show_name or "").strip()
                    if sn and sn != "כללי" and sn.lower() not in (title or "").lower():
                        d = f"{sn}: {base}".strip() if base else sn
                    else:
                        d = base or title or price or "Deal"
                    row = {
                        "m": venue,
                        "c": "BEHATSDAA",
                        "d": d or title or price or "Deal",
                        "_bhKey": f"bh-{seq}",
                    }
                    seq += 1
                    if url:
                        row["url"] = url
                    flat.append(row)
    return flat


def _flatten_behatsdaa(nested_data):
    flat = []
    for category, venues in nested_data.items():
        for venue, shows in venues.items():
            for show_name, deals in shows.items():
                for deal in deals:
                    search_string = (
                        f"[{category}] {venue} - {show_name}: {deal['title']} ({deal['price']}) at {deal['address']}"
                    )
                    url = (deal.get("url") or "").strip()
                    flat.append({
                        "m": venue,
                        "c": "BEHATSDAA",
                        "d": f"{deal['title']} ({deal['price']})",
                        "search_text": search_string,
                        "url": url,
                    })
    return flat


def _behatsdaa_embed_cache_key(fd):
    url = fd.get("url") or ""
    if url:
        return f"u:{hashlib.sha256(url.encode('utf-8')).hexdigest()}"
    return f"h:{hashlib.sha256(fd['search_text'].encode('utf-8')).hexdigest()}"


def _behatsdaa_embed_md_key(fd):
    return f"md:{hashlib.sha256((fd['m'] + '||' + fd['d']).encode('utf-8')).hexdigest()}"


def _behatsdaa_vector_row(fd, vec, cache_key, et):
    return {
        "m": fd["m"],
        "c": fd["c"],
        "d": fd["d"],
        "v": vec,
        "embed_id": cache_key,
        "_et": et,
        "url": fd.get("url") or "",
    }


def _load_behatsdaa_embedding_cache(json_path):
    cache = {}
    if not os.path.isfile(json_path):
        return cache
    try:
        with open(json_path, encoding="utf-8") as f:
            data = json.load(f)
    except Exception:
        return cache
    nested = data.get("data") or {}
    vecs = data.get("vectors") or []
    flat_prev = _flatten_behatsdaa(nested)
    n = min(len(flat_prev), len(vecs))
    for i in range(n):
        fd = flat_prev[i]
        vrec = vecs[i]
        if "v" not in vrec:
            continue
        et = vrec.get("_et") or fd["search_text"]
        k = vrec.get("embed_id") or _behatsdaa_embed_cache_key(fd)
        entry = {"v": vrec["v"], "et": et}
        cache[k] = entry
        cache[_behatsdaa_embed_md_key(fd)] = entry
    for vrec in vecs:
        if "v" not in vrec:
            continue
        mk = f"md:{hashlib.sha256((vrec['m'] + '||' + vrec['d']).encode('utf-8')).hexdigest()}"
        if mk not in cache:
            et_guess = vrec.get("_et") or f"{vrec['m']} {vrec['d']}"
            cache[mk] = {"v": vrec["v"], "et": et_guess}
    return cache


def _embed_batch_with_retry_behatsdaa(texts):
    delays = [2, 5, 10, 20, 35, 55, 90, 120]
    last_err = None
    for attempt, wait in enumerate(delays):
        try:
            return client.models.embed_content(
                model="gemini-embedding-001",
                contents=texts,
                config=types.EmbedContentConfig(task_type="RETRIEVAL_DOCUMENT"),
            )
        except Exception as e:
            last_err = e
            msg = str(e).lower()
            if "429" in msg or "resource_exhausted" in msg or "quota" in msg:
                print(f"  Rate limited (attempt {attempt + 1}/{len(delays)}); sleeping {wait}s …")
                time.sleep(wait)
                continue
            raise
    raise last_err or RuntimeError("Embedding failed after retries")


def generate_embeddings(nested_data):
    """Vectors for RAG; reuses embeddings from existing data.json when deal text/url unchanged."""
    print("\n--- Generating AI Search Vectors (incremental) ---")
    flat_deals = _flatten_behatsdaa(nested_data)
    print(f"Total deals (flattened): {len(flat_deals)}")

    cache = _load_behatsdaa_embedding_cache(DATA_JSON_PATH)
    filled = [None] * len(flat_deals)
    pending_indices = []
    reused = 0

    for i, fd in enumerate(flat_deals):
        et = fd["search_text"]
        k = _behatsdaa_embed_cache_key(fd)
        hit = None
        use_key = k
        if k in cache and cache[k]["et"] == et:
            hit = cache[k]
        else:
            mk = _behatsdaa_embed_md_key(fd)
            if mk in cache and cache[mk]["et"] == et:
                hit = cache[mk]
                use_key = k
        if hit:
            filled[i] = _behatsdaa_vector_row(fd, hit["v"], use_key, et)
            reused += 1
        else:
            pending_indices.append(i)

    need_api = len(flat_deals) - reused
    print(f"Embeddings: {reused} reused from cache, {need_api} require API")

    for b_start in range(0, len(pending_indices), _EMBED_BATCH):
        batch_idx = pending_indices[b_start : b_start + _EMBED_BATCH]
        batch_fds = [flat_deals[i] for i in batch_idx]
        texts = [fd["search_text"] for fd in batch_fds]
        print(f"  API batch: {len(texts)} texts …")
        response = _embed_batch_with_retry_behatsdaa(texts)
        for j, embedding in enumerate(response.embeddings):
            gi = batch_idx[j]
            fd = flat_deals[gi]
            et = fd["search_text"]
            k = _behatsdaa_embed_cache_key(fd)
            filled[gi] = _behatsdaa_vector_row(fd, embedding.values, k, et)
        if _EMBED_SLEEP and b_start + _EMBED_BATCH < len(pending_indices):
            time.sleep(_EMBED_SLEEP)

    missing = [i for i, row in enumerate(filled) if row is None]
    if missing:
        raise RuntimeError(f"Missing embeddings at indices {missing[:15]}")

    print("Vector generation complete!")
    return filled

# ==========================================
# 4. PAGE SCRAPING LOGIC
# ==========================================
#
# Outputs:
# - cardsdeven/public/data.json — nested "data" + "vectors" (embeddings cache for the scraper). Keep locally; gitignored.
# - cardsdeven/public/behatsdaa_deals.json — flat "deals" for the web app. Commit / deploy this.

def _normalize_behatsdaa_href(href: str) -> str:
    href = (href or "").strip()
    if not href:
        return ""
    if href.startswith("/"):
        return BEHATSDAA_ORIGIN.rstrip("/") + href
    if not href.startswith("http"):
        return BEHATSDAA_ORIGIN.rstrip("/") + "/" + href.lstrip("/")
    return href


def _extract_href_from_dom(card) -> str:
    href = ""
    try:
        href = card.evaluate(
            """(el) => {
              const bad = (h) => !h || h === '#' || h.toLowerCase().startsWith('javascript:');
              const pick = (x) => { const h = (x || '').trim(); return bad(h) ? '' : h; };
              const root = el.closest ? (el.closest('.categories-container-item') || el) : el;
              if (root && root.querySelectorAll) {
                for (const a of root.querySelectorAll('a[href]')) {
                  const h = pick(a.getAttribute('href'));
                  if (h) return h;
                }
              }
              let p = root;
              for (let i = 0; i < 12 && p; i++) {
                if (p.tagName === 'A') {
                  const h = pick(p.getAttribute('href'));
                  if (h) return h;
                }
                p = p.parentElement;
              }
              return '';
            }"""
        )
        href = (href or "").strip()
    except Exception:
        try:
            al = card.locator("a[href]")
            if al.count() > 0:
                href = (al.first.get_attribute("href") or "").strip()
        except Exception:
            pass
    return _normalize_behatsdaa_href(href)


def _capture_sale_url_via_click(page, card, listing_url: str) -> str:
    """Open sale via click, read window URL, return to listing. For JS/routed cards without href."""
    if os.environ.get("BEHATSDAA_SKIP_URL_CLICKS", "").strip().lower() in ("1", "true", "yes"):
        return ""
    before = page.url
    try:
        card.scroll_into_view_if_needed(timeout=5000)
        page.wait_for_timeout(150)
    except Exception:
        pass

    captured = None
    try:
        with page.expect_navigation(timeout=14000, wait_until="domcontentloaded"):
            card.click(timeout=7000)
        captured = (page.url or "").strip()
    except Exception:
        n_before = len(page.context.pages)
        try:
            card.click(timeout=7000, force=True)
            page.wait_for_timeout(600)
            if len(page.context.pages) > n_before:
                np = page.context.pages[-1]
                try:
                    np.wait_for_load_state("domcontentloaded", timeout=15000)
                    captured = (np.url or "").strip()
                finally:
                    np.close()
                page.bring_to_front()
                if captured and captured.startswith("http"):
                    return _normalize_behatsdaa_href(captured)
            for _ in range(35):
                u = (page.url or "").strip()
                if u and u != before:
                    captured = u
                    break
                page.wait_for_timeout(200)
        except Exception:
            pass

    if not captured or not captured.startswith("http"):
        if (page.url or "").strip() != before:
            try:
                page.go_back(wait_until="domcontentloaded", timeout=15000)
            except Exception:
                pass
        return ""

    try:
        page.go_back(wait_until="domcontentloaded", timeout=20000)
        page.wait_for_load_state("networkidle", timeout=35000)
        page.wait_for_timeout(500)
    except Exception as exc:
        print(f"  go_back after URL capture failed ({exc}); reloading listing …")
        try:
            page.goto(listing_url, wait_until="networkidle", timeout=45000)
            page.wait_for_timeout(800)
        except Exception:
            pass

    return _normalize_behatsdaa_href(captured)


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
        listing_url = page.url
        n = page.locator(".categories-container-item").count()
        print(f"Found {n} sales on this page.")

        for idx in range(n):
            card = page.locator(".categories-container-item").nth(idx)
            try:
                title = card.locator(".categories-container-item-header .medium-font").inner_text(timeout=1000).strip()
                price = card.locator(".categories-container-item-price .price-text").inner_text(timeout=1000).strip()
                address = card.locator(".categories-container-item-location .location-name-text").inner_text(timeout=1000).strip()

                href = _extract_href_from_dom(card)
                if not href:
                    if idx == 0 or (idx + 1) % 25 == 0:
                        print(f"  Capturing URL via click ({idx + 1}/{n}) …")
                    href = _capture_sale_url_via_click(page, card, listing_url)

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
                    "address": address,
                    "url": href,
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
            deals_light = {
                "last_updated": final_json["last_updated"],
                "deals": flatten_behatsdaa_deals_for_app(all_scraped_data),
            }
            with open("cardsdeven/public/behatsdaa_deals.json", "w", encoding="utf-8") as f:
                json.dump(deals_light, f, ensure_ascii=False, indent=2)
            print("\nScraping complete. Data saved to cardsdeven/public/data.json and behatsdaa_deals.json.")

        except Exception as e:
            print(f"A critical error occurred: {e}")
        finally:
            browser.close()
            push_to_github()

if __name__ == "__main__":
    should_be_visible = "--visible" in sys.argv
    run_scraper(headless_mode=not should_be_visible)