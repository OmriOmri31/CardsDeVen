"""Gemini embeddings for the non-vision scrapers.

Keys are used in order: GEMINI_API_KEY, GEMINI_API_KEY_2, GEMINI_API_KEY_3.
The active key stays put until a request fails with an HTTP 429 quota error.
That request is then retried on the next key. Other errors stay on the current key.
"""

from __future__ import annotations

import os
import time

from google import genai
from google.genai import types

_KEY_ENVS = ("GEMINI_API_KEY", "GEMINI_API_KEY_2", "GEMINI_API_KEY_3")
_EMBED_MODEL = "gemini-embedding-001"
_RATE_DELAYS = (2, 5, 10, 20, 35, 55, 90, 120)

_pool: "GeminiEmbedPool | None" = None


def gemini_api_keys() -> list[str]:
    keys: list[str] = []
    for name in _KEY_ENVS:
        value = (os.environ.get(name) or "").strip()
        if value and value not in keys:
            keys.append(value)
    return keys


def require_gemini_keys() -> list[str]:
    keys = gemini_api_keys()
    if not keys:
        raise ValueError(
            "No Gemini API keys found. Set GEMINI_API_KEY, GEMINI_API_KEY_2, "
            "and GEMINI_API_KEY_3 in .env or cardsdeven/.env."
        )
    return keys


def _error_blob(exc: BaseException) -> str:
    parts = [str(exc)]
    for attr in ("message", "status", "details"):
        value = getattr(exc, attr, None)
        if value:
            parts.append(str(value))
    return " ".join(parts).lower()


def is_quota_429(exc: BaseException) -> bool:
    """True only for HTTP 429 that reports Gemini quota exhaustion."""
    code = getattr(exc, "code", None)
    blob = _error_blob(exc)
    if code != 429 and "429" not in blob:
        return False
    if code not in (None, 429):
        return False
    return "quota" in blob or "resource_exhausted" in blob


def _is_same_key_rate_limit(exc: BaseException) -> bool:
    """429 that is not quota. Retry the same key instead of switching."""
    if is_quota_429(exc):
        return False
    code = getattr(exc, "code", None)
    blob = _error_blob(exc)
    return code == 429 or (code is None and "429" in blob)


class GeminiEmbedPool:
    def __init__(self, keys: list[str] | None = None) -> None:
        self.keys = list(keys) if keys is not None else require_gemini_keys()
        if not self.keys:
            raise ValueError("GeminiEmbedPool needs at least one API key.")
        self.index = 0
        self._client: genai.Client | None = None
        print(
            f"Gemini embeddings: {len(self.keys)} key(s), "
            "starting on key 1 (switch only after a quota 429).",
            flush=True,
        )

    def _client_for_current(self) -> genai.Client:
        if self._client is None:
            self._client = genai.Client(api_key=self.keys[self.index])
        return self._client

    def _switch_after_quota(self) -> bool:
        if self.index + 1 >= len(self.keys):
            return False
        failed = self.index + 1
        self.index += 1
        self._client = None
        print(
            f"  Gemini key {failed} returned a quota 429. "
            f"Switching to key {self.index + 1}/{len(self.keys)}.",
            flush=True,
        )
        return True

    def embed_documents(self, texts: list[str]):
        rate_attempt = 0
        while True:
            try:
                return self._client_for_current().models.embed_content(
                    model=_EMBED_MODEL,
                    contents=texts,
                    config=types.EmbedContentConfig(task_type="RETRIEVAL_DOCUMENT"),
                )
            except Exception as exc:
                if is_quota_429(exc):
                    if self._switch_after_quota():
                        rate_attempt = 0
                        continue
                    raise
                if _is_same_key_rate_limit(exc) and rate_attempt < len(_RATE_DELAYS):
                    wait = _RATE_DELAYS[rate_attempt]
                    rate_attempt += 1
                    print(
                        f"  Gemini key {self.index + 1} rate limited "
                        f"(attempt {rate_attempt}/{len(_RATE_DELAYS)}); sleeping {wait}s …",
                        flush=True,
                    )
                    time.sleep(wait)
                    continue
                raise


def get_embed_pool() -> GeminiEmbedPool:
    global _pool
    if _pool is None:
        _pool = GeminiEmbedPool()
    return _pool


def embed_documents(texts: list[str]):
    return get_embed_pool().embed_documents(texts)
