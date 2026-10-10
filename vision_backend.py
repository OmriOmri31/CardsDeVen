"""Vision backends for DreamCard banner reading.

DreamCard vision defaults to deepseek-flash. These providers all accept an image
and return the same JSON shape the scraper already expects.

  gpt-6-luna      OpenAI, current Luna model (text + image)
  deepseek-flash  DeepSeek's cheapest vision model (V4.1-Flash)
  moondream2      local Ollama tag moondream:1.8b
  pixtral-12b     local Ollama GGUF of Pixtral 12B

Gemini remains available by setting VISION_PROVIDER=gemini.
"""

from __future__ import annotations

import base64
import json
import os
import re
import time
import urllib.error
import urllib.request
from typing import Any

# Current Luna snapshot. gpt-5.6-luna is the previous generation.
GPT_LUNA_MODEL = "gpt-6-luna"
# Cheapest DeepSeek model that accepts images. The old id
# deepseek-v4-flash-vision-exp still routes here, but new calls should use this.
DEEPSEEK_VISION_MODEL = "deepseek-flash"
DEEPSEEK_BASE_URL = "https://api.deepseek.com"
# Ollama library: moondream:1.8b is Moondream 2 (1.8B). `latest` currently
# points at the same weights; the tag is pinned so a later library update
# cannot silently swap the model.
MOONDREAM_OLLAMA_MODEL = "moondream:1.8b"
# This machine has 8 GB RAM and no discrete GPU, so the trial uses the
# smallest Pixtral 12B quant that can load. Override PIXTRAL_OLLAMA_MODEL
# for a larger quant on a bigger machine.
PIXTRAL_OLLAMA_MODEL = "hf.co/EnlistedGhost/Pixtral-12B-2409-GGUF:Q2_K"

_ALIASES = {
    "gpt-6-luna": "gpt-6-luna",
    "gpt-luna": "gpt-6-luna",
    "luna": "gpt-6-luna",
    "gpt-5.6-luna": "gpt-5.6-luna",
    "deepseek-flash": "deepseek-flash",
    "deepseek": "deepseek-flash",
    "deepseek-v4-flash": "deepseek-flash",
    "deepseek-v4-flash-vision-exp": "deepseek-flash",
    "moondream2": "moondream2",
    "moondream": "moondream2",
    "moondream-2": "moondream2",
    "pixtral-12b": "pixtral-12b",
    "pixtral": "pixtral-12b",
    "pixtral12b": "pixtral-12b",
}


class VisionError(Exception):
    def __init__(
        self,
        message: str,
        *,
        http_status: int | None = None,
        fatal: bool = False,
    ) -> None:
        super().__init__(message)
        self.http_status = http_status
        self.fatal = fatal


def canonical_provider(name: str) -> str:
    key = (name or "").strip().lower()
    if key not in _ALIASES:
        known = ", ".join(sorted(set(_ALIASES.values())))
        raise VisionError(f"Unknown vision provider {name!r}. Known: {known}", fatal=True)
    return _ALIASES[key]


def _strip_code_fence(text: str) -> str:
    t = (text or "").strip()
    if t.startswith("```"):
        t = re.sub(r"^```(?:json)?\s*", "", t, flags=re.I)
        t = re.sub(r"\s*```\s*$", "", t)
    return t.strip()


def _coerce_banner(parsed: dict[str, Any]) -> dict[str, Any]:
    merchant = str(parsed.get("merchant") or "").strip()
    lines = parsed.get("lines")
    if isinstance(lines, str):
        lines = [lines]
    if not isinstance(lines, list):
        lines = []
    clean = [str(x).strip() for x in lines if str(x).strip()]
    return {"merchant": merchant, "lines": clean}


def _parse_banner(text: str) -> dict[str, Any]:
    t = _strip_code_fence(text)
    start = t.find("{")
    end = t.rfind("}")
    if start >= 0 and end > start:
        t = t[start : end + 1]
    return _coerce_banner(json.loads(t))


def _ollama_model(provider: str) -> str:
    if provider == "moondream2":
        return (os.environ.get("MOONDREAM_OLLAMA_MODEL") or MOONDREAM_OLLAMA_MODEL).strip()
    return (os.environ.get("PIXTRAL_OLLAMA_MODEL") or PIXTRAL_OLLAMA_MODEL).strip()


def _ollama_host() -> str:
    return (os.environ.get("OLLAMA_HOST") or "http://127.0.0.1:11434").rstrip("/")


def _data_url(png: bytes) -> str:
    return "data:image/png;base64," + base64.b64encode(png).decode("ascii")


def _chat_completion(
    *,
    provider: str,
    png: bytes,
    prompt: str,
    model: str | None = None,
) -> str:
    from openai import APIStatusError, OpenAI

    if provider == "gpt-6-luna":
        api_key = (os.environ.get("OPENAI_API_KEY") or "").strip()
        if not api_key:
            raise VisionError("OPENAI_API_KEY is not set.", fatal=True)
        client = OpenAI(api_key=api_key, timeout=90)
        model = (model or os.environ.get("OPENAI_VISION_MODEL") or GPT_LUNA_MODEL).strip()
        extra: dict[str, Any] = {}
        token_key = "max_completion_tokens"
    elif provider == "deepseek-flash":
        api_key = (os.environ.get("DEEPSEEK_API_KEY") or "").strip()
        if not api_key:
            raise VisionError("DEEPSEEK_API_KEY is not set.", fatal=True)
        client = OpenAI(api_key=api_key, base_url=DEEPSEEK_BASE_URL, timeout=90)
        model = (os.environ.get("DEEPSEEK_VISION_MODEL") or DEEPSEEK_VISION_MODEL).strip()
        extra = {"extra_body": {"thinking": {"type": "disabled"}}}
        token_key = "max_tokens"
    else:
        raise VisionError(f"{provider} is not an API vision provider.", fatal=True)

    messages = [
        {
            "role": "user",
            "content": [
                {"type": "text", "text": prompt},
                {
                    "type": "image_url",
                    "image_url": {"url": _data_url(png), "detail": "high"},
                },
            ],
        }
    ]
    kwargs: dict[str, Any] = {
        "model": model,
        "messages": messages,
        token_key: 500,
        "response_format": {"type": "json_object"},
        **extra,
    }
    if provider == "gpt-6-luna":
        kwargs["reasoning_effort"] = (os.environ.get("OPENAI_REASONING_EFFORT") or "low").strip()

    max_attempts = 4
    last_err: Exception | None = None
    for attempt in range(1, max_attempts + 1):
        if attempt > 1:
            time.sleep(min(20.0, 2.0 ** (attempt - 1)))
        try:
            resp = client.chat.completions.create(**kwargs)
            text = (resp.choices[0].message.content or "").strip()
            return text
        except APIStatusError as e:
            last_err = e
            status = int(getattr(e, "status_code", 0) or 0)
            blob = str(e).lower()
            if status in (400, 404) and "response_format" in kwargs and (
                "response_format" in blob or "json" in blob
            ):
                kwargs.pop("response_format", None)
                continue
            if status == 400 and "reasoning_effort" in kwargs and "reasoning" in blob:
                kwargs.pop("reasoning_effort", None)
                continue
            if status == 400 and "thinking" in blob and "extra_body" in kwargs:
                kwargs.pop("extra_body", None)
                continue
            if status == 400 and token_key == "max_completion_tokens" and "max_completion_tokens" in blob:
                kwargs.pop("max_completion_tokens", None)
                kwargs["max_tokens"] = 500
                token_key = "max_tokens"
                continue
            if status in (401, 402, 403, 404) or any(
                token in blob
                for token in ("insufficient_quota", "credit_balance", "insufficient balance")
            ):
                raise VisionError(
                    f"{provider} HTTP {status}: {e}",
                    http_status=status,
                    fatal=True,
                ) from e
            if status == 429 or status >= 500:
                if attempt < max_attempts:
                    continue
            raise VisionError(f"{provider} HTTP {status}: {e}", http_status=status) from e
        except Exception as e:
            last_err = e
            if attempt < max_attempts:
                continue
            raise VisionError(f"{provider} request failed: {e}") from e
    raise VisionError(f"{provider} request failed: {last_err}")


def _ollama_chat(*, provider: str, png: bytes, prompt: str) -> str:
    model = _ollama_model(provider)
    body = {
        "model": model,
        "stream": False,
        "keep_alive": "30m",
        "messages": [
            {
                "role": "user",
                "content": prompt,
                "images": [base64.b64encode(png).decode("ascii")],
            }
        ],
        "options": {"temperature": 0, "num_predict": 300, "num_ctx": 2048},
    }
    timeout = 180 if provider == "moondream2" else 420
    req = urllib.request.Request(
        _ollama_host() + "/api/chat",
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")[:500]
        fatal = e.code == 404
        raise VisionError(
            f"Ollama {provider} HTTP {e.code}: {detail}",
            http_status=e.code,
            fatal=fatal,
        ) from e
    except Exception as e:
        raise VisionError(
            f"Ollama {provider} ({model}) failed: {e}. "
            "Is `ollama serve` running and the model pulled?"
        ) from e
    message = payload.get("message") or {}
    return str(message.get("content") or "").strip()


def extract_banner(png: bytes, prompt: str, *, provider: str) -> dict[str, Any]:
    """Read one banner. Returns merchant + lines. Raises VisionError on hard failure."""
    name = canonical_provider(provider)
    t0 = time.perf_counter()
    api_model = name if name == "gpt-5.6-luna" else None
    if name in ("gpt-6-luna", "gpt-5.6-luna", "deepseek-flash"):
        call_name = "gpt-6-luna" if name.startswith("gpt-") else name
        raw = _chat_completion(provider=call_name, png=png, prompt=prompt, model=api_model)
    else:
        raw = _ollama_chat(provider=name, png=png, prompt=prompt)
    elapsed = time.perf_counter() - t0
    if not raw:
        return {"merchant": "", "lines": [], "_raw": "", "_seconds": elapsed, "_provider": name}
    try:
        parsed = _parse_banner(raw)
    except json.JSONDecodeError:
        repair = prompt + "\nYour previous reply was not valid JSON. Reply again with ONLY the JSON object."
        if name in ("gpt-6-luna", "gpt-5.6-luna", "deepseek-flash"):
            call_name = "gpt-6-luna" if name.startswith("gpt-") else name
            raw2 = _chat_completion(provider=call_name, png=png, prompt=repair, model=api_model)
        else:
            raw2 = _ollama_chat(provider=name, png=png, prompt=repair)
        elapsed = time.perf_counter() - t0
        try:
            parsed = _parse_banner(raw2)
            raw = raw2
        except json.JSONDecodeError:
            parsed = {"merchant": "", "lines": [raw2[:500]]}
            raw = raw2
    parsed["_raw"] = raw
    parsed["_seconds"] = elapsed
    parsed["_provider"] = name
    return parsed
