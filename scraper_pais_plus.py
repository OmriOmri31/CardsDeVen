"""
מנוי פיס (Pais Plus) — category & deal scraper.

Entry: https://www.pais.co.il/info/paisplus.aspx (no login).
Discovers .swiper.mySwiper1, .mySwiper2, ... collects category links from slides
(deduped), then scrapes each paisplus.co.il category page for a.card-item deals.

Output: cardsdeven/public/pais_plus_data.json
  - deals: [{ "m", "c": "PAIS_PLUS", "d", ... }] compatible with App.jsx DISCOUNTS_DATA

Manual run:
  python scraper_pais_plus.py
  python scraper_pais_plus.py --visible
  python scraper_pais_plus.py --embed   # optional Gemini vectors (needs GEMINI_API_KEY)
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from playwright.sync_api import sync_playwright
from playwright_stealth import Stealth

try:
    from dotenv import load_dotenv

    load_dotenv("cardsdeven/.env")
except ImportError:
    pass

PAIS_LANDING = "https://www.pais.co.il/info/paisplus.aspx"
PAIS_PLUS_ORIGIN = "https://paisplus.co.il"
OUTPUT_PATH = os.path.join("cardsdeven", "public", "pais_plus_data.json")
CLUB_CODE = "PAIS_PLUS"

# Safety cap so a site change does not loop forever
MAX_SWIPERS = 30


def strip_utms(url: str) -> str:
    if not url:
        return ""
    parts = urlsplit(url.strip())
    q = [(k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True) if not k.lower().startswith("utm_")]
    return urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(q) if q else "", parts.fragment))


def absolutize_paisplus(href: str) -> str | None:
    if not href:
        return None
    h = href.strip()
    if h.startswith("//"):
        h = "https:" + h
    if h.startswith("/"):
        h = PAIS_PLUS_ORIGIN + h
    if "paisplus.co.il" not in h:
        return None
    if not h.startswith("http"):
        return None
    # Category or product pages only
    if "/category/" not in h and "/product/" not in h:
        return None
    return strip_utms(h.split("#")[0])


def normalize_category_url(href: str) -> str | None:
    u = absolutize_paisplus(href)
    if not u or "/category/" not in u:
        return None
    return u


def scroll_page_for_lazy_cards(page, rounds: int = 10) -> None:
    for _ in range(rounds):
        page.evaluate("window.scrollBy(0, Math.floor(window.innerHeight * 0.95))")
        page.wait_for_timeout(350)
    page.evaluate("window.scrollTo(0, 0)")
    page.wait_for_timeout(200)


def discover_category_links(page) -> list[tuple[str, str]]:
    """Return list of (category_url, genre_label) from all mySwiperN carousels."""
    print(f"Loading landing page: {PAIS_LANDING}")
    page.goto(PAIS_LANDING, wait_until="domcontentloaded", timeout=60000)
    page.wait_for_timeout(2500)
    try:
        page.wait_for_selector("div.swiper[class*='mySwiper']", timeout=15000)
    except Exception:
        print("Warning: no swiper found quickly; continuing anyway.")

    seen: dict[str, str] = {}

    for n in range(1, MAX_SWIPERS + 1):
        sel = f"div.swiper.mySwiper{n}"
        loc = page.locator(sel)
        if loc.count() == 0:
            print(f"No {sel}; stopping swiper discovery at index {n - 1 or 'none'}.")
            break

        print(f"Scanning {sel} ...")
        swiper = loc.first
        slides = swiper.locator(".swiper-slide")
        count = slides.count()
        for i in range(count):
            slide = slides.nth(i)
            link = slide.locator('a[href*="paisplus.co.il"], a[href^="/"]').first
            if link.count() == 0:
                continue
            href = link.get_attribute("href")
            cat_url = normalize_category_url(href) if href else None
            if not cat_url:
                continue
            genre = ""
            try:
                genre = slide.locator(".artist-title").first.inner_text(timeout=800).strip()
            except Exception:
                try:
                    genre = link.locator("img").first.get_attribute("alt") or ""
                    genre = genre.strip()
                except Exception:
                    genre = ""

            if cat_url not in seen and genre:
                seen[cat_url] = genre
            elif cat_url not in seen:
                seen[cat_url] = "כללי"

    out = [(u, seen[u]) for u in seen]
    print(f"Discovered {len(out)} unique category URLs.")
    return out


def inner_text_safe(locator, timeout: float = 2000) -> str:
    try:
        return locator.inner_text(timeout=timeout).strip()
    except Exception:
        return ""


def scrape_category_page(page, category_url: str, genre: str) -> list[dict]:
    deals: list[dict] = []
    print(f"  Category ({genre}): {category_url}")
    try:
        page.goto(category_url, wait_until="domcontentloaded", timeout=60000)
    except Exception as e:
        print(f"  Skip (load error): {e}")
        return deals

    page.wait_for_timeout(1500)
    try:
        page.wait_for_selector("a.card-item", timeout=20000)
    except Exception:
        print("  No card-item on page; skipping.")
        return deals

    scroll_page_for_lazy_cards(page, rounds=12)

    items = page.locator("a.card-item").all()
    print(f"  Found {len(items)} card-item anchors.")

    for item in items:
        try:
            cls = item.get_attribute("class") or ""
            if "category-page" not in cls and "regular" not in cls:
                # Still accept generic card-item from listing pages
                pass

            href = item.get_attribute("href") or ""
            product_url = absolutize_paisplus(href)
            data_id = item.get_attribute("data-id") or ""

            title = inner_text_safe(item.locator("h3.card-title").first)
            if not title:
                title = inner_text_safe(item.locator(".card-title").first)
            sub = inner_text_safe(item.locator(".card-sub-title").first)
            # Flatten nested <p> noise
            sub = re.sub(r"\s+", " ", sub).strip()

            price_num = inner_text_safe(item.locator(".price-number").first)
            price_pre = inner_text_safe(item.locator(".price-text").first)
            price = f"{price_pre} {price_num}".strip() if price_pre or price_num else ""

            if not title:
                continue

            desc_parts = [p for p in [sub, price] if p]
            d = " | ".join(desc_parts) if desc_parts else price or sub or title

            row = {
                "m": title,
                "c": CLUB_CODE,
                "d": d,
                "genre": genre,
                "category_url": category_url,
            }
            if product_url:
                row["product_url"] = product_url
            if data_id:
                row["product_id"] = data_id

            deals.append(row)
        except Exception:
            continue

    return deals


def dedupe_deals(deals: list[dict]) -> list[dict]:
    seen: set[tuple] = set()
    out: list[dict] = []
    for d in deals:
        key = (d.get("m", ""), d.get("d", ""), d.get("product_id", ""), d.get("product_url", ""))
        if key in seen:
            continue
        seen.add(key)
        out.append(d)
    return out


def run_embed_deals(flat_deals: list[dict]) -> list[dict]:
    """Optional: same vector shape as scraper.py for retrieval."""
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        raise ValueError("GEMINI_API_KEY not set; cannot embed.")

    from google import genai
    from google.genai import types

    client = genai.Client(api_key=api_key)
    vectorized: list[dict] = []
    batch_size = 100

    for i in range(0, len(flat_deals), batch_size):
        batch = flat_deals[i : i + batch_size]
        texts = []
        for item in batch:
            genre = item.get("genre", "")
            texts.append(f"[פיס פלוס / {genre}] {item['m']}: {item['d']}")

        print(f"Embedding batch {i}–{i + len(batch)} …")
        response = client.models.embed_content(
            model="gemini-embedding-001",
            contents=texts,
            config=types.EmbedContentConfig(task_type="RETRIEVAL_DOCUMENT"),
        )
        for j, embedding in enumerate(response.embeddings):
            deal = batch[j]
            vectorized.append(
                {
                    "m": deal["m"],
                    "c": CLUB_CODE,
                    "d": deal["d"],
                    "v": embedding.values,
                }
            )
        print("Batch complete. Sleeping 60s for quota …")
        time.sleep(60)

    return vectorized


def main() -> int:
    if sys.platform == "win32":
        try:
            sys.stdout.reconfigure(encoding="utf-8")
            sys.stderr.reconfigure(encoding="utf-8")
        except Exception:
            pass

    parser = argparse.ArgumentParser(description="Scrape Pais Plus deals from pais.co.il landing carousels.")
    parser.add_argument("--visible", action="store_true", help="Show browser window")
    parser.add_argument("--embed", action="store_true", help="Generate Gemini embeddings (slow; needs API key)")
    args = parser.parse_args()

    all_deals: list[dict] = []

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=not args.visible)
        context = browser.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
            viewport={"width": 1400, "height": 900},
        )
        page = context.new_page()
        Stealth().apply_stealth_sync(page)

        try:
            categories = discover_category_links(page)
            for cat_url, genre in categories:
                all_deals.extend(scrape_category_page(page, cat_url, genre))
        finally:
            browser.close()

    all_deals = dedupe_deals(all_deals)
    print(f"\nTotal unique deals: {len(all_deals)}")

    payload: dict = {
        "last_updated": time.strftime("%Y-%m-%d %H:%M:%S"),
        "source": "pais_plus",
        "deals": all_deals,
    }

    if args.embed and all_deals:
        slim = [{"m": d["m"], "c": d["c"], "d": d["d"], "genre": d.get("genre", "")} for d in all_deals]
        payload["vectors"] = run_embed_deals(slim)

    os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
    with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)

    print(f"Wrote {OUTPUT_PATH}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
