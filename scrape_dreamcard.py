"""
DreamCard / DreamCard VIP promo scraper for CardsDeVen.

Opens the public deals page, filters by DREAMCARD then Dreamcard VIP, screenshots each
dc-deal tile, and uses Gemini vision (Hebrew-friendly) to extract merchant + offer text.

Output: cardsdeven/public/dreamcard_deals.json

Banner tiles use lazy-loaded images: the script waits for .deal-img to decode / meaningful alt before
reading alt or taking screenshots, so alt-only runs after Gemini 429 still get real copy when possible.

Env:
  GEMINI_API_KEY (required)
  DREAMCARD_DEALS_URL (optional, default https://online.dreamcard.co.il/public/deals)
  DREAMCARD_VISION_MODEL (optional, default gemini-2.5-flash)
  DREAMCARD_HEADLESS (optional: set 1/true for headless; default is visible browser locally)
  DREAMCARD_SLOW_MO_MS (optional: Playwright slow_mo in ms, e.g. 200, for easier watching)
  DREAMCARD_SKIP_VISION (optional: 1/true = never call Gemini; use img alt text only)
  DREAMCARD_VISION_MAX_ATTEMPTS (optional, default 5) — total tries per Gemini request on 429 exponential backoff
  DREAMCARD_VISION_429_BASE_SEC (optional, default 5) — first wait after 429 is this many seconds; then 2×, 4×, …
  DREAMCARD_VISION_THROTTLE_SEC (optional, default 1.25) — pause before each tile after the first (spaces API calls)
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import time
from typing import Any

from dotenv import load_dotenv
from google import genai
from google.genai import types
from google.genai.errors import APIError, ClientError, ServerError
from playwright.sync_api import sync_playwright

_REPO_ROOT = os.path.dirname(os.path.abspath(__file__))
_OUTPUT_PATH = os.path.join(_REPO_ROOT, "cardsdeven", "public", "dreamcard_deals.json")
_DEFAULT_URL = "https://online.dreamcard.co.il/public/deals"
_DEFAULT_VISION_MODEL = "gemini-2.5-flash"

load_dotenv(os.path.join(_REPO_ROOT, ".env"))
load_dotenv(os.path.join(_REPO_ROOT, "cardsdeven", ".env"))


def _log(msg: str) -> None:
    """Line-buffered log for CMD / CI (flush so progress is visible during long API calls)."""
    ts = time.strftime("%H:%M:%S")
    line = f"[{ts}] {msg}"
    print(line, flush=True)


def _preview(text: str, max_len: int = 140) -> str:
    t = re.sub(r"\s+", " ", (text or "").strip())
    if len(t) <= max_len:
        return t
    return t[: max_len - 1] + "…"


def _stable_blob_hash(blob: str) -> str:
    """Deterministic key fragment (Python hash() is salted per process)."""
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()[:24]


def _clean_banner_alt(alt: str) -> str:
    """Normalize CMS/OCR junk in img[alt] (see logs: ocrtext, Latin+Hebrew 'n' gluing)."""
    if not alt:
        return ""
    t = alt.replace("\\n", " ").replace("\r", " ").replace("\n", " ")
    t = re.sub(r"(?i)ocrtext\s*", "", t)
    t = re.sub(r"([A-Za-z])n([\u0590-\u05FF])", r"\1 \2", t)
    t = re.sub(r"([\u0590-\u05FF])n([A-Za-z])", r"\1 \2", t)
    t = re.sub(r"\s+", " ", t).strip()
    return t


def _merchant_from_clean_alt(clean_alt: str) -> str:
    if not clean_alt:
        return ""
    m = re.split(r"[\d%]", clean_alt, maxsplit=1)[0].strip()
    m = re.sub(r"\s*-\s*$", "", m).strip()
    return m


def _wait_for_deal_banner(page, img_locator, *, timeout_ms: int = 10000) -> None:
    """Lazy-loaded .deal-img: wait for real dimensions or meaningful alt (logs showed empty alt if we read too early)."""
    deadline = time.perf_counter() + timeout_ms / 1000.0
    while time.perf_counter() < deadline:
        if not img_locator.count():
            page.wait_for_timeout(200)
            continue
        alt = (img_locator.get_attribute("alt") or "").strip()
        if len(alt) >= 8:
            return
        try:
            img_locator.evaluate(
                "el => { try { if (el.decode) el.decode(); } catch (e) {} }"
            )
            nw = int(img_locator.evaluate("el => el.naturalWidth || 0"))
        except Exception:
            nw = 0
        if nw >= 120:
            page.wait_for_timeout(450)
            return
        page.wait_for_timeout(220)


def _playwright_headless() -> bool:
    """Default: headed (visible). CI should set DREAMCARD_HEADLESS=1."""
    v = (os.environ.get("DREAMCARD_HEADLESS") or "").strip().lower()
    if v in ("1", "true", "yes", "on"):
        return True
    if v in ("0", "false", "no", "off"):
        return False
    return False


def _playwright_slow_mo_ms() -> int:
    raw = (os.environ.get("DREAMCARD_SLOW_MO_MS") or "").strip()
    try:
        n = int(raw, 10)
    except ValueError:
        return 0
    return max(0, n)


def _env_truthy(name: str) -> bool:
    v = (os.environ.get(name) or "").strip().lower()
    return v in ("1", "true", "yes", "on")


def _vision_max_attempts() -> int:
    raw = (os.environ.get("DREAMCARD_VISION_MAX_ATTEMPTS") or "5").strip()
    try:
        n = int(raw, 10)
    except ValueError:
        n = 5
    return max(1, min(12, n))


def _vision_429_base_sec() -> float:
    raw = (os.environ.get("DREAMCARD_VISION_429_BASE_SEC") or "5").strip()
    try:
        x = float(raw)
    except ValueError:
        x = 5.0
    return max(1.0, min(120.0, x))


def _vision_throttle_sec() -> float:
    raw = (os.environ.get("DREAMCARD_VISION_THROTTLE_SEC") or "1.25").strip()
    try:
        x = float(raw)
    except ValueError:
        x = 1.25
    return max(0.0, min(60.0, x))


class VisionRunFlags:
    """Mutable flags shared across passes; HTTP 404 can disable vision for the rest of the run."""

    __slots__ = ("skip_vision",)

    def __init__(self, skip_vision: bool = False) -> None:
        self.skip_vision = skip_vision


_VISION_PROMPT = """You are reading a promotional banner from the Israeli DreamCard member deals site.
The image may contain Hebrew, English, or both. Extract the store/brand name and every distinct line of offer text visible on the banner (headlines, percentages, conditions).

Return ONLY valid JSON with this exact shape (no markdown fences):
{"merchant":"brand or store name as shown","lines":["line1","line2"]}

If text is unreadable, do your best. Use empty strings only if there is no text at all."""


def _strip_code_fence(text: str) -> str:
    t = text.strip()
    if t.startswith("```"):
        t = re.sub(r"^```(?:json)?\s*", "", t, flags=re.I)
        t = re.sub(r"\s*```\s*$", "", t)
    return t.strip()


def _parse_vision_json(text: str) -> dict[str, Any]:
    t = _strip_code_fence(text)
    return json.loads(t)


def _gemini_client_error_inspect_blob(exc: APIError) -> str:
    """Lowercased text blob for substring checks (message + details; API often puts quota text in details)."""
    parts: list[str] = []
    msg = getattr(exc, "message", None)
    if msg:
        parts.append(str(msg))
    det = getattr(exc, "details", None)
    if det is not None:
        if isinstance(det, (dict, list)):
            try:
                parts.append(json.dumps(det, ensure_ascii=False))
            except (TypeError, ValueError):
                parts.append(str(det))
        else:
            parts.append(str(det))
    parts.append(str(exc))
    return " ".join(parts).lower()


def _gemini_generate_with_retry(
    client: genai.Client,
    model: str,
    parts: list,
    *,
    log_label: str,
) -> str:
    """
    One logical Gemini vision/text request. HTTP 404: raise immediately (no retries).
    HTTP 429 (non-quota) and server errors (5xx, e.g. 503 UNAVAILABLE): exponential backoff; 429 quota fails fast.
    """
    max_attempts = _vision_max_attempts()
    base = _vision_429_base_sec()
    last_err: APIError | None = None
    for attempt in range(1, max_attempts + 1):
        if attempt > 1:
            wait = base * (2 ** (attempt - 2))
            _log(
                f"Gemini{log_label}: HTTP 429/5xx — exponential backoff: sleeping {wait:.1f}s "
                f"before attempt {attempt}/{max_attempts}…"
            )
            time.sleep(wait)
        else:
            _log(f"Gemini{log_label}: attempt {attempt}/{max_attempts}…")
        try:
            resp = client.models.generate_content(model=model, contents=parts)
            if attempt > 1:
                _log(f"Gemini{log_label}: succeeded after backoff on attempt {attempt}/{max_attempts}.")
            return (resp.text or "").strip()
        except APIError as e:
            last_err = e
            api_msg = getattr(e, "message", None)
            err_kind = type(e).__name__
            _log(
                f"Gemini{log_label}: {err_kind} HTTP {e.code} (attempt {attempt}/{max_attempts}) — "
                f"message={api_msg!r}"
            )
            if e.code == 404:
                _log(
                    f"Gemini{log_label}: HTTP 404 — model not available or wrong name; "
                    f"skipping backoff/retry."
                )
                raise e
            if e.code == 429:
                blob = _gemini_client_error_inspect_blob(e)
                if "quota" in blob:
                    _log(
                        f"Gemini{log_label}: 429 includes quota exhaustion — skipping backoff/retry for this "
                        f"call; raising so tile can use alt text."
                    )
                    raise e
                if attempt < max_attempts:
                    _log(
                        f"Gemini{log_label}: treating 429 as rate limit (no quota signal) — "
                        f"will retry with exponential backoff."
                    )
                    continue
                raise
            if isinstance(e, ServerError):
                if attempt < max_attempts:
                    _log(
                        f"Gemini{log_label}: server error HTTP {e.code} — will retry with exponential backoff "
                        f"({attempt}/{max_attempts})."
                    )
                    continue
                raise
            raise
    raise last_err  # pragma: no cover


def _vision_extract(client: genai.Client, model: str, png: bytes) -> dict[str, Any]:
    part_img = types.Part.from_bytes(data=png, mime_type="image/png")
    part_txt = types.Part.from_text(text=_VISION_PROMPT)
    raw = _gemini_generate_with_retry(client, model, [part_img, part_txt], log_label="[vision]")
    if not raw:
        return {"merchant": "", "lines": []}
    try:
        return _parse_vision_json(raw)
    except json.JSONDecodeError:
        _log("Gemini[vision]: reply was not valid JSON — sending one repair prompt (with same 429 retry policy)…")
        raw2 = _gemini_generate_with_retry(
            client,
            model,
            [
                part_img,
                types.Part.from_text(
                    text=_VISION_PROMPT
                    + "\nYour previous reply was not valid JSON. Reply again with ONLY the JSON object."
                ),
            ],
            log_label="[vision-json-repair]",
        )
        try:
            return _parse_vision_json(raw2)
        except json.JSONDecodeError:
            _log("Gemini[vision-json-repair]: still not valid JSON — using raw snippet as one line.")
            return {"merchant": "", "lines": [raw2[:500]]}


def _click_toggle_exact(page, label: str) -> None:
    loc = page.locator("mat-button-toggle").filter(
        has=page.locator(
            ".mat-button-toggle-label-content",
            has_text=re.compile(f"^{re.escape(label)}$", re.I),
        )
    )
    btn = loc.locator("button").first
    btn.wait_for(state="visible", timeout=20000)
    btn.click()
    page.wait_for_timeout(2200)


def _normalize_href(h: str | None) -> str:
    if not h:
        return ""
    h = h.strip()
    if not h.startswith("http"):
        return ""
    if re.fullmatch(r"https?://online\.dreamcard\.co\.il/#?", h):
        return ""
    return h


def _deal_promo_url(deal) -> str:
    """Prefer the anchor that wraps the banner image (first http link was often wrong or #)."""
    wrap = deal.locator("a:has(img.deal-img)").first
    if wrap.count():
        h = _normalize_href(wrap.get_attribute("href"))
        if h:
            return h
    for cand in deal.locator("a[href]").evaluate_all("els => els.map(e => e.getAttribute('href') || '')"):
        h = _normalize_href(cand)
        if h:
            return h
    return ""


def _img_asset_key(src: str | None) -> str:
    if not src:
        return ""
    s = src.strip()
    if "/assets/media/" in s:
        return s.split("/assets/media/", 1)[-1].split("?", 1)[0]
    if s.startswith("assets/media/"):
        return s[len("assets/media/") :].split("?", 1)[0]
    return s.split("/")[-1].split("?", 1)[0] if s else ""


def _dedup_key(m: str, d: str, img_key: str, url: str) -> str:
    blob = re.sub(r"\s+", " ", f"{m}||{d}").strip().lower()
    if img_key:
        return f"i:{img_key}"
    if url:
        return f"u:{url}"
    return f"t:{_stable_blob_hash(blob)}"


def _scrape_toggle_view(
    page,
    client: genai.Client,
    model: str,
    toggle_label: str,
    *,
    phase: str,
    vision_flags: VisionRunFlags,
) -> list[dict[str, Any]]:
    _log(f"{phase} — clicking filter tab «{toggle_label}»…")
    _click_toggle_exact(page, toggle_label)
    page.wait_for_timeout(800)
    deals = page.locator(".deals-container dc-deal")
    n = deals.count()
    _log(f"{phase} — found {n} deal tile(s) in .deals-container")
    out: list[dict[str, Any]] = []
    for i in range(n):
        idx = i + 1
        if i > 0 and not vision_flags.skip_vision:
            th = _vision_throttle_sec()
            if th > 0:
                _log(f"{phase} — inter-tile throttle {th:.2f}s before tile {idx}/{n} (reduces Gemini 429 bursts)…")
                time.sleep(th)
        deal = deals.nth(i)
        _log(f"{phase} — tile {idx}/{n}: scrolling into view…")
        deal.scroll_into_view_if_needed()
        page.wait_for_timeout(450)
        img_el = deal.locator("img.deal-img").first
        _log(f"{phase} — tile {idx}/{n}: waiting for lazy banner image / alt…")
        _wait_for_deal_banner(page, img_el)
        href = _deal_promo_url(deal)
        src = img_el.get_attribute("src") if img_el.count() else ""
        img_key = _img_asset_key(src)
        raw_alt = (img_el.get_attribute("alt") or "").strip() if img_el.count() else ""
        alt = _clean_banner_alt(raw_alt)
        if not alt and vision_flags.skip_vision:
            _log(
                f"{phase} — tile {idx}/{n}: banner alt still empty after wait — "
                f"check network or increase timeout; may get placeholder row."
            )

        if vision_flags.skip_vision:
            _log(
                f"{phase} — tile {idx}/{n}: vision disabled — using img alt only (no API call)…"
            )
            png = b""
            parsed: dict[str, Any] = {"merchant": "", "lines": []}
            t0 = time.perf_counter()
            dt = time.perf_counter() - t0
        else:
            _log(f"{phase} — tile {idx}/{n}: taking screenshot ({img_key or 'no asset key'})…")
            png = deal.screenshot(type="png")
            _log(
                f"{phase} — tile {idx}/{n}: calling Gemini vision ({len(png)} bytes; "
                f"429/5xx use exponential backoff, not stuck)…"
            )
            t0 = time.perf_counter()
            try:
                parsed = _vision_extract(client, model, png)
            except APIError as e:
                if e.code == 404:
                    _log(
                        "Model not found (HTTP 404). Disabling vision API for all remaining tiles."
                    )
                    vision_flags.skip_vision = True
                elif isinstance(e, ServerError):
                    _log(
                        f"{phase} — tile {idx}/{n}: Gemini server unavailable or overloaded (HTTP {e.code}) "
                        f"after retries — this tile: fallback to img alt; continuing with remaining tiles."
                    )
                else:
                    _log(
                        f"{phase} — tile {idx}/{n}: vision API failed ({type(e).__name__} HTTP {e.code}) — "
                        f"this tile: fallback to img alt; next tiles still use vision unless quota/404."
                    )
                parsed = {"merchant": "", "lines": []}
            dt = time.perf_counter() - t0
        merchant = (parsed.get("merchant") or "").strip()
        if not merchant:
            merchant = _merchant_from_clean_alt(alt) or "DreamCard"
        if not merchant:
            merchant = "DreamCard"
        lines = parsed.get("lines")
        if isinstance(lines, list):
            parts = [str(x).strip() for x in lines if str(x).strip()]
        else:
            parts = []
        desc = " | ".join(parts) if parts else ""
        if not desc:
            desc = alt or "מבצע"
        row: dict[str, Any] = {
            "m": merchant,
            "c": "DREAMCARD",
            "d": desc,
            "_dreamKey": _dedup_key(merchant, desc, img_key, href),
        }
        if href:
            row["url"] = href
        out.append(row)
        src_note = f"url={href}" if href else "no external url"
        _log(
            f"{phase} — tile {idx}/{n}: done in {dt:.1f}s | m={_preview(merchant, 60)!r} | "
            f"d={_preview(desc)!r} | {src_note}"
        )
        time.sleep(0.35)
    _log(f"{phase} — finished all {n} tile(s) for this filter.")
    return out


def main() -> None:
    api_key = (os.environ.get("GEMINI_API_KEY") or "").strip()
    if not api_key:
        raise SystemExit("GEMINI_API_KEY is not set (add to .env or cardsdeven/.env).")

    url = (os.environ.get("DREAMCARD_DEALS_URL") or _DEFAULT_URL).strip()
    model = (os.environ.get("DREAMCARD_VISION_MODEL") or _DEFAULT_VISION_MODEL).strip()

    headless = _playwright_headless()
    slow_mo = _playwright_slow_mo_ms()
    _log("========== DreamCard scrape starting ==========")
    _log(f"URL: {url}")
    _log(f"Vision model: {model}")
    _log(f"Playwright headless={headless} slow_mo_ms={slow_mo}")
    _log(
        f"Vision retries: max_attempts={_vision_max_attempts()} 429_base_sec={_vision_429_base_sec():.1f} "
        f"inter_tile_throttle_sec={_vision_throttle_sec():.2f}"
    )
    _log(f"Output: {_OUTPUT_PATH}")

    vision_flags = VisionRunFlags(skip_vision=_env_truthy("DREAMCARD_SKIP_VISION"))
    if vision_flags.skip_vision:
        _log("DREAMCARD_SKIP_VISION is set — Gemini will not be called; using image alt / DOM text only.")

    client = genai.Client(api_key=api_key)
    merged: list[dict[str, Any]] = []
    seen: set[str] = set()

    launch_kw: dict[str, Any] = {"headless": headless}
    if slow_mo > 0:
        launch_kw["slow_mo"] = slow_mo

    with sync_playwright() as p:
        _log("Launching Chromium…")
        browser = p.chromium.launch(**launch_kw)
        context = browser.new_context(viewport={"width": 1440, "height": 900})
        page = context.new_page()
        try:
            _log("Loading deals page (wait_until=domcontentloaded, timeout=90s)…")
            page.goto(url, wait_until="domcontentloaded", timeout=90000)
            page.wait_for_timeout(3000)
            _log(f"Page ready — title={page.title()!r} final_url={page.url}")

            _log("---------- Pass 1: standard DreamCard filter ----------")
            standard = _scrape_toggle_view(
                page,
                client,
                model,
                "DREAMCARD",
                phase="Pass 1 [DREAMCARD]",
                vision_flags=vision_flags,
            )
            added = 0
            skipped = 0
            for row in standard:
                k = row.pop("_dreamKey", None) or _dedup_key(row["m"], row["d"], "", row.get("url", ""))
                if k in seen:
                    skipped += 1
                    _log(f"Pass 1 merge: skip duplicate key {k!r}")
                    continue
                seen.add(k)
                merged.append(row)
                added += 1
                _log(f"Pass 1 merge: +1 deal (total unique so far: {len(merged)}) — {_preview(row['m'], 40)!r} / {_preview(row['d'], 80)!r}")
            _log(f"Pass 1 summary: {added} new deal(s) kept, {skipped} duplicate(s) dropped, running total {len(merged)}.")

            _log("---------- Pass 2: Dreamcard VIP filter ----------")
            vip_view = _scrape_toggle_view(
                page,
                client,
                model,
                "Dreamcard VIP",
                phase="Pass 2 [VIP]",
                vision_flags=vision_flags,
            )
            v_added = 0
            v_skip = 0
            for row in vip_view:
                k = row.pop("_dreamKey", None) or _dedup_key(row["m"], row["d"], "", row.get("url", ""))
                if k in seen:
                    v_skip += 1
                    _log(f"Pass 2 merge: skip duplicate (already in standard) key {k!r}")
                    continue
                seen.add(k)
                row["d"] = f"(DreamCard VIP) {row['d']}"
                merged.append(row)
                v_added += 1
                _log(
                    f"Pass 2 merge: +1 VIP-only deal (total unique: {len(merged)}) — "
                    f"{_preview(row['m'], 40)!r} / {_preview(row['d'], 80)!r}"
                )
            _log(
                f"Pass 2 summary: {v_added} VIP-only deal(s) added, {v_skip} duplicate(s) skipped, final total {len(merged)}."
            )
        finally:
            _log("Closing browser…")
            context.close()
            browser.close()

    payload = {
        "last_updated": time.strftime("%Y-%m-%d %H:%M:%S"),
        "source_url": url,
        "deals": merged,
    }
    os.makedirs(os.path.dirname(_OUTPUT_PATH), exist_ok=True)
    _log(f"Writing JSON ({len(merged)} deals)…")
    with open(_OUTPUT_PATH, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    _log(f"Done — wrote {len(merged)} deals to {_OUTPUT_PATH}")
    _log("========== DreamCard scrape finished ==========")


if __name__ == "__main__":
    main()
