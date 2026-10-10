"""
מנוי פיס (Pais Plus) — category & deal scraper.

Entry: a Pais Plus category page (no login). The full menu tree is in
window.__PRELOADED_STATE__. Leaf categories are scraped for a.card-item deals.

The old entry, https://www.pais.co.il/info/paisplus.aspx, is a Webflow page whose
synchronous scripts often never fire DOMContentLoaded from GitHub-hosted runners.
That made page.goto hit its timeout (60s, then 90s x retries) and the run exited
before writing pais_plus_deals.json.

Output: cardsdeven/public/pais_plus_data.json
  - deals: [{ "m", "c": "PAIS_PLUS", "d", ... }] compatible with App.jsx DISCOUNTS_DATA
  - vectors: Gemini embeddings (same shape as scraper_behatsdaa.py), unless --no-embed

Embeddings are incremental: vectors are reused from the previous pais_plus_data.json when
deal content is unchanged (product_id or text signature), so routine scrapes only call the
API for new/changed deals — not ~800+ requests every run.

Optional env:
  PAIS_EMBED_BATCH_SIZE=100   (max 100 — Gemini API hard limit per embed_content call)
  PAIS_EMBED_SLEEP_SEC=2      (pause between batches; default 2)

By default: embeds with Gemini (GEMINI_API_KEY, then GEMINI_API_KEY_2, then
GEMINI_API_KEY_3, switching only after a quota 429) and runs git add/commit/push for
pais_plus_data.json (same idea as scraper_behatsdaa.py → data.json).

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

# Any category page embeds the full menu. 374 is a small public leaf, used only as the seed.
PAIS_MENU_SEED = "https://paisplus.co.il/category/374"
PAIS_PLUS_ORIGIN = "https://paisplus.co.il"
OUTPUT_PATH = os.path.join("cardsdeven", "public", "pais_plus_data.json")
DEALS_PUBLIC_PATH = os.path.join("cardsdeven", "public", "pais_plus_deals.json")
CLUB_CODE = "PAIS_PLUS"

# Trackers and fonts that have stalled navigation. The deal HTML does not need them.
_BLOCK_RESOURCE_TYPES = {"image", "media", "font"}
_BLOCK_HOST_PARTS = (
    "taboola.com",
    "outbrain.com",
    "clarity.ms",
    "facebook.net",
    "facebook.com",
    "doubleclick.net",
    "google-analytics.com",
    "googletagmanager.com",
    "googleadservices.com",
    "glassix.com",
    "hotjar.com",
)

# Gemini embed_content allows at most 100 texts per request (BatchEmbedContentsRequest).
_EMBED_BATCH = min(100, max(1, int(os.environ.get("PAIS_EMBED_BATCH_SIZE", "100"))))
_EMBED_SLEEP = max(0.0, float(os.environ.get("PAIS_EMBED_SLEEP_SEC", "2")))

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


def install_request_filter(context) -> None:
    """Drop images, fonts, and ad pixels so a hanging tracker cannot stall navigation."""

    def handle(route) -> None:
        request = route.request
        if request.resource_type in _BLOCK_RESOURCE_TYPES:
            route.abort()
            return
        host = (urlsplit(request.url).hostname or "").lower()
        if any(part in host for part in _BLOCK_HOST_PARTS):
            route.abort()
            return
        route.continue_()

    context.route("**/*", handle)


def clean_label(text: str) -> str:
    text = re.sub(r"[\U0001F000-\U0001FAFF\u2600-\u27BF\uFE0F\u200D]", "", text or "")
    return re.sub(r"\s+", " ", text).strip()


def goto_with_retries(page, url: str, *, label: str, attempts: int = 3, timeout_ms: int = 45000) -> None:
    """Retry navigation. `commit` returns when the document starts, before third-party scripts."""
    last_error: Exception | None = None
    for attempt in range(1, attempts + 1):
        print(f"{label}opening {url} (attempt {attempt}/{attempts})", flush=True)
        try:
            page.goto(url, wait_until="commit", timeout=timeout_ms)
            print(f"{label}loaded", flush=True)
            return
        except Exception as exc:
            last_error = exc
            print(f"{label}load failed: {exc}", flush=True)
            if attempt < attempts:
                page.wait_for_timeout(2000)
    raise last_error or RuntimeError(f"Failed to open {url}")


def _walk_menu(nodes, out: list[tuple[str, str]], seen: set[str]) -> None:
    """Collect leaf categories. Parents are aggregates (thousands of deals, paginated)."""
    for node in nodes or []:
        if not isinstance(node, dict):
            continue
        children = node.get("categories") or []
        if children:
            _walk_menu(children, out, seen)
            continue
        cid = str(node.get("category_id") or "").strip()
        name = clean_label(str(node.get("name") or ""))
        if not cid or not name or cid in seen:
            continue
        if name.startswith("מועדפות"):
            continue
        seen.add(cid)
        out.append((f"{PAIS_PLUS_ORIGIN}/category/{cid}", name))


def _discover_from_dom(page) -> list[tuple[str, str]]:
    rows = page.evaluate(
        """() => {
          const out = [];
          const seen = new Set();
          for (const a of document.querySelectorAll("a[href*='/category/']")) {
            const href = a.getAttribute("href") || "";
            const match = href.match(/\\/category\\/(\\d+)/);
            if (!match || seen.has(match[1])) continue;
            const text = (a.innerText || "").replace(/\\s+/g, " ").trim();
            if (!text) continue;
            seen.add(match[1]);
            out.push({ href, text });
          }
          return out;
        }"""
    )
    out: list[tuple[str, str]] = []
    for row in rows or []:
        name = clean_label(row.get("text") or "")
        if not name or name.startswith("מועדפות"):
            continue
        cat_url = normalize_category_url(row.get("href") or "")
        if cat_url:
            out.append((cat_url, name))
    return out


def discover_category_links(page) -> list[tuple[str, str]]:
    """Return (category_url, genre) for every public leaf in the Pais Plus menu."""
    goto_with_retries(page, PAIS_MENU_SEED, label="Pais Plus menu: ")
    try:
        page.wait_for_function(
            "() => window.__PRELOADED_STATE__ && window.__PRELOADED_STATE__.config && window.__PRELOADED_STATE__.config.categories",
            timeout=20000,
        )
        tree = page.evaluate("() => window.__PRELOADED_STATE__.config.categories")
        out: list[tuple[str, str]] = []
        _walk_menu(tree, out, set())
        if out:
            print(f"Discovered {len(out)} leaf categories from the Pais Plus menu.")
            return out
        print("Menu state had no leaf categories; reading links from the page.")
    except Exception as exc:
        print(f"Menu state unavailable ({exc}); reading links from the page.")

    out = _discover_from_dom(page)
    print(f"Discovered {len(out)} category URLs from page links.")
    return out


def inner_text_safe(locator, timeout: float = 2000) -> str:
    try:
        return locator.inner_text(timeout=timeout).strip()
    except Exception:
        return ""


def scrape_category_page(page, category_url: str, genre: str) -> list[dict]:
    deals: list[dict] = []
    print(f"  Category ({genre}): {category_url}", flush=True)
    try:
        goto_with_retries(page, category_url, label="  ", attempts=2, timeout_ms=90000)
    except Exception as e:
        print(f"  Skip (load error): {e}", flush=True)
        return deals

    page.wait_for_timeout(800)
    try:
        page.wait_for_selector("a.card-item", timeout=12000)
    except Exception:
        print("  No card-item on page; skipping.")
        return deals

    try:
        scroll_page_for_lazy_cards(page, rounds=6)
    except Exception as exc:
        print(f"  Scroll skipped: {exc}", flush=True)

    items = page.locator("a.card-item").all()
    print(f"  Found {len(items)} card-item anchors.")

    for item in items:
        try:
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
                row["url"] = product_url
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
    u = deal.get("url") or deal.get("product_url") or ""
    row = {
        "m": deal["m"],
        "c": CLUB_CODE,
        "d": deal["d"],
        "v": vec,
        "embed_id": cache_key,
        "_et": et,
    }
    if u:
        row["url"] = u
    return row


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


def _embed_batch_with_retry(texts: list[str]):
    """Embed with the shared key pool. Quota 429 moves to the next key."""
    from gemini_embed import embed_documents

    return embed_documents(texts)


def run_embed_deals_incremental(all_deals: list[dict]) -> list[dict]:
    """Embed only new/changed deals; reuse vectors from existing OUTPUT_PATH."""
    from gemini_embed import require_gemini_keys

    require_gemini_keys()
    cache = load_embedding_cache(OUTPUT_PATH)

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
        response = _embed_batch_with_retry(texts)
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


def previous_deal_count(json_path: str) -> int:
    if not os.path.isfile(json_path):
        return 0
    try:
        with open(json_path, encoding="utf-8") as f:
            data = json.load(f)
    except Exception:
        return 0
    return len(data.get("deals") or [])


def push_to_github() -> None:
    """Commit and push slim pais_plus_deals.json (vectors stay in local pais_plus_data.json only)."""
    if os.environ.get("SKIP_GIT_PUSH", "").strip().lower() in ("1", "true", "yes"):
        print("SKIP_GIT_PUSH set; skipping git push.")
        return
    print("--- Git Automation (pais_plus_deals.json) ---")
    try:
        if not os.path.isfile(DEALS_PUBLIC_PATH):
            print("No pais_plus_deals.json to commit.")
            return
        subprocess.run(["git", "add", "cardsdeven/public/pais_plus_deals.json"], check=True)
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

    parser = argparse.ArgumentParser(description="Scrape Pais Plus deals from the paisplus.co.il menu.")
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
        print("Pais Plus: launching Chromium", flush=True)
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=not args.visible)
            context = browser.new_context(
                user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
                viewport={"width": 1400, "height": 900},
            )
            install_request_filter(context)
            page = context.new_page()
            Stealth().apply_stealth_sync(page)
            print("Pais Plus: Chromium is open", flush=True)

            try:
                categories = discover_category_links(page)
                total = len(categories)
                print(f"Pais Plus: {total} categories to scrape", flush=True)
                for index, (cat_url, genre) in enumerate(categories, start=1):
                    print(f"Pais Plus: category {index}/{total}", flush=True)
                    all_deals.extend(scrape_category_page(page, cat_url, genre))
            finally:
                browser.close()

        all_deals = dedupe_deals(all_deals)
        print(f"\nTotal unique deals: {len(all_deals)}")

        if not all_deals:
            print("No deals scraped; existing files were left unchanged.")
            exit_code = 1
        else:
            previous = previous_deal_count(DEALS_PUBLIC_PATH)
            if previous >= 80 and len(all_deals) < int(previous * 0.4):
                print(
                    f"Refusing to replace {previous} deals with {len(all_deals)}. "
                    "Existing files were left unchanged."
                )
                exit_code = 1
            else:
                payload: dict = {
                    "last_updated": time.strftime("%Y-%m-%d %H:%M:%S"),
                    "source": "pais_plus",
                    "deals": all_deals,
                }
                slim = {
                    "last_updated": payload["last_updated"],
                    "source": "pais_plus",
                    "deals": all_deals,
                }
                os.makedirs(os.path.dirname(OUTPUT_PATH) or ".", exist_ok=True)
                # Publish the catalog before embeddings. A Gemini failure used to
                # discard a finished scrape and leave the site on last week's deals.
                with open(DEALS_PUBLIC_PATH, "w", encoding="utf-8") as f:
                    json.dump(slim, f, ensure_ascii=False, indent=2)
                print(f"Wrote {DEALS_PUBLIC_PATH} ({len(all_deals)} deals)")

                if not args.no_embed:
                    try:
                        payload["vectors"] = run_embed_deals_incremental(all_deals)
                    except Exception as embed_exc:
                        print(f"Embeddings failed; published deals anyway. {embed_exc}", flush=True)
                else:
                    print("\n--- Skipping embeddings (--no-embed) ---")

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
