"""
מנוי פיס (Pais Plus) — category & deal scraper.

Entry: https://www.pais.co.il/info/paisplus.aspx (no login).
Discovers .swiper.mySwiper1, .mySwiper2, ... collects category links from slides
(deduped), then scrapes each paisplus.co.il category page for a.card-item deals.

Output: cardsdeven/public/pais_plus_data.json
  - deals: [{ "m", "c": "PAIS_PLUS", "d", ... }] compatible with App.jsx DISCOUNTS_DATA
  - vectors: Gemini embeddings (same shape as scraper.py), unless --no-embed

Embeddings are incremental: vectors are reused from the previous pais_plus_data.json when
deal content is unchanged (product_id or text signature), so routine scrapes only call the
API for new/changed deals — not ~800+ requests every run.

Optional env:
  PAIS_EMBED_BATCH_SIZE=100   (max 100 — Gemini API hard limit per embed_content call)
  PAIS_EMBED_SLEEP_SEC=2      (pause between batches; default 2)

By default: embeds with Gemini (needs GEMINI_API_KEY) and runs git add/commit/push for
pais_plus_data.json (same idea as scraper.py → data.json).

Manual run:
  python scraper_pais_plus.py
  python scraper_pais_plus.py --visible
  python scraper_pais_plus.py --no-embed   # skip vectors (faster; no GEMINI_API_KEY)
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import time
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from playwright.sync_api import sync_playwright
from playwright_stealth import Stealth

_REPO_ROOT = os.path.dirname(os.path.abspath(__file__))

try:
    from dotenv import load_dotenv

    load_dotenv(os.path.join(_REPO_ROOT, ".env"))
    load_dotenv(os.path.join(_REPO_ROOT, "cardsdeven", ".env"))
except ImportError:
    pass

PAIS_LANDING = "https://www.pais.co.il/info/paisplus.aspx"
PAIS_PLUS_ORIGIN = "https://paisplus.co.il"
OUTPUT_PATH = os.path.join("cardsdeven", "public", "pais_plus_data.json")
CLUB_CODE = "PAIS_PLUS"

# Gemini embed_content allows at most 100 texts per request (BatchEmbedContentsRequest).
_EMBED_BATCH = min(100, max(1, int(os.environ.get("PAIS_EMBED_BATCH_SIZE", "100"))))
_EMBED_SLEEP = max(0.0, float(os.environ.get("PAIS_EMBED_SLEEP_SEC", "2")))

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


def embed_text(deal: dict) -> str:
    genre = deal.get("genre") or ""
    return f"[פיס פלוס / {genre}] {deal['m']}: {deal['d']}"


def embed_cache_key(deal: dict) -> str:
    if deal.get("product_id"):
        return f"pid:{deal['product_id']}"
    genre = deal.get("genre") or ""
    h = hashlib.sha256(f"{deal['m']}\x1e{deal['d']}\x1e{genre}".encode("utf-8")).hexdigest()
    return f"sig:{h}"


def embed_md_fallback_key(deal: dict) -> str:
    """Legacy rows without genre in cache text — match on title + body only."""
    return f"md:{hashlib.sha256((deal['m'] + '||' + deal['d']).encode('utf-8')).hexdigest()}"


def _vector_row(deal: dict, vec: list, cache_key: str, et: str) -> dict:
    return {
        "m": deal["m"],
        "c": CLUB_CODE,
        "d": deal["d"],
        "v": vec,
        "embed_id": cache_key,
        "_et": et,
    }


def load_embedding_cache(json_path: str) -> dict[str, dict]:
    """Map cache_key -> {v, et} from previous scrape file."""
    cache: dict[str, dict] = {}
    if not os.path.isfile(json_path):
        return cache
    try:
        with open(json_path, encoding="utf-8") as f:
            data = json.load(f)
    except Exception:
        return cache

    deals_prev = data.get("deals") or []
    vecs_prev = data.get("vectors") or []
    n = min(len(deals_prev), len(vecs_prev))
    for i in range(n):
        drec = deals_prev[i]
        vrec = vecs_prev[i]
        if "v" not in vrec:
            continue
        et = embed_text(drec)
        k = embed_cache_key(drec)
        entry = {"v": vrec["v"], "et": vrec.get("_et") or et}
        cache[k] = entry
        cache[embed_md_fallback_key(drec)] = entry

    for vrec in vecs_prev:
        if "v" not in vrec:
            continue
        mk = f"md:{hashlib.sha256((vrec['m'] + '||' + vrec['d']).encode('utf-8')).hexdigest()}"
        if mk not in cache:
            cache[mk] = {"v": vrec["v"], "et": vrec.get("_et") or embed_text({"m": vrec["m"], "d": vrec["d"], "genre": "", "c": CLUB_CODE})}

    return cache


def _embed_batch_with_retry(client, types_mod, texts: list[str]) -> list:
    """Call embed_content with backoff on 429 / RESOURCE_EXHAUSTED."""
    delays = [2, 5, 10, 20, 35, 55, 90, 120]
    last_err: Exception | None = None
    for attempt, wait in enumerate(delays):
        try:
            return client.models.embed_content(
                model="gemini-embedding-001",
                contents=texts,
                config=types_mod.EmbedContentConfig(task_type="RETRIEVAL_DOCUMENT"),
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


def run_embed_deals_incremental(all_deals: list[dict]) -> list[dict]:
    """Embed only new/changed deals; reuse vectors from existing OUTPUT_PATH."""
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        raise ValueError("GEMINI_API_KEY not set; cannot embed.")

    from google import genai
    from google.genai import types

    cache = load_embedding_cache(OUTPUT_PATH)
    client = genai.Client(api_key=api_key)

    n = len(all_deals)
    filled: list[dict | None] = [None] * n
    pending_indices: list[int] = []
    reused = 0

    for i, deal in enumerate(all_deals):
        et = embed_text(deal)
        k = embed_cache_key(deal)
        hit = None
        use_key = k
        if k in cache and cache[k]["et"] == et:
            hit = cache[k]
        else:
            mk = embed_md_fallback_key(deal)
            if mk in cache and cache[mk]["et"] == et:
                hit = cache[mk]
                use_key = k
        if hit:
            filled[i] = _vector_row(deal, hit["v"], use_key, et)
            reused += 1
        else:
            pending_indices.append(i)

    need_api = n - reused
    print(f"\n--- Embeddings: {reused} reused from cache, {need_api} require API ---")

    for b_start in range(0, len(pending_indices), _EMBED_BATCH):
        batch_idx = pending_indices[b_start : b_start + _EMBED_BATCH]
        batch_deals = [all_deals[i] for i in batch_idx]
        texts = [embed_text(d) for d in batch_deals]
        print(f"  API batch: {len(batch_deals)} texts (indices {b_start}–{b_start + len(batch_idx)} of pending) …")
        response = _embed_batch_with_retry(client, types, texts)
        for j, embedding in enumerate(response.embeddings):
            gi = batch_idx[j]
            deal = all_deals[gi]
            et = texts[j]
            k = embed_cache_key(deal)
            filled[gi] = _vector_row(deal, embedding.values, k, et)
        if _EMBED_SLEEP and b_start + _EMBED_BATCH < len(pending_indices):
            time.sleep(_EMBED_SLEEP)

    missing = [i for i, row in enumerate(filled) if row is None]
    if missing:
        raise RuntimeError(f"Internal error: missing embeddings at indices {missing[:10]}…")

    return [filled[i] for i in range(n)]  # type: ignore[list-item]


def push_to_github() -> None:
    """Commit and push pais_plus_data.json (mirrors scraper.py behavior for data.json)."""
    print("--- Git Automation (pais_plus_data.json) ---")
    try:
        subprocess.run(["git", "add", "cardsdeven/public/pais_plus_data.json"], check=True)
        commit_msg = f"auto-scrape pais+: {time.strftime('%Y-%m-%d %H:%M:%S')}"
        subprocess.run(["git", "commit", "-m", commit_msg], check=True)
        print("Pulling latest changes from GitHub...")
        subprocess.run(["git", "pull", "--rebase"], check=True)
        print("Pushing to GitHub...")
        subprocess.run(["git", "push"], check=True)
        print("Successfully pushed to GitHub!")
    except subprocess.CalledProcessError as e:
        print(f"Git update skipped: no changes, conflict, or network issue. ({e})")
    except FileNotFoundError:
        print("Git is not installed or not in PATH. Skipping push.")
    print("------------------------------")


def main() -> int:
    if sys.platform == "win32":
        try:
            sys.stdout.reconfigure(encoding="utf-8")
            sys.stderr.reconfigure(encoding="utf-8")
        except Exception:
            pass

    parser = argparse.ArgumentParser(description="Scrape Pais Plus deals from pais.co.il landing carousels.")
    parser.add_argument("--visible", action="store_true", help="Show browser window")
    parser.add_argument(
        "--no-embed",
        action="store_true",
        help="Skip Gemini embeddings (faster; omit vectors from JSON; no GEMINI_API_KEY needed)",
    )
    parser.add_argument(
        "--no-push",
        action="store_true",
        help="Do not git commit/push pais_plus_data.json after writing",
    )
    args = parser.parse_args()

    all_deals: list[dict] = []
    exit_code = 0

    try:
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

        if not args.no_embed and all_deals:
            payload["vectors"] = run_embed_deals_incremental(all_deals)
        elif args.no_embed:
            print("\n--- Skipping embeddings (--no-embed) ---")

        os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
        with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)

        print(f"Wrote {OUTPUT_PATH}")
    except Exception as e:
        print(f"A critical error occurred: {e}")
        exit_code = 1
    finally:
        if not args.no_push:
            push_to_github()

    return exit_code


if __name__ == "__main__":
    sys.exit(main())
