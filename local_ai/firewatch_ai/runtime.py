"""Local inference runtime + hardware compatibility detection.

Inference goes to **a local Ollama server on loopback** (`127.0.0.1:11434` by
default). This module never calls a hosted API, never downloads weights, and
never shells out. If the runtime is missing, `status()` reports it and the server
answers from the knowledge base with an explicit notice.

The model map is a recommendation, not a promise. There is no guarantee a given
model runs on a given laptop; the profile is chosen from available RAM and a GPU
is reported as "decided by Ollama", because this code does not query a GPU vendor
tool and will not invent a VRAM figure.
"""
from __future__ import annotations

import ctypes
import json
import os
import platform
import shutil
import subprocess
import sys
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Iterator

OLLAMA_URL = os.environ.get("FIREWATCH_OLLAMA_URL", "http://127.0.0.1:11434").rstrip("/")
DEFAULT_MODEL = os.environ.get("FIREWATCH_MODEL", "qwen2.5:7b-instruct")


@dataclass(frozen=True)
class ModelProfile:
    profile: str
    model: str
    parameters: str
    context: str
    approx_vram: str
    licence: str
    note: str


PROFILES = {
    "A": ModelProfile(
        "A", "llama3.2:3b-instruct", "3 B", "8 192 tokens", "~2.0 GB",
        "Llama 3.2 Community License",
        "Low-resource CPU profile. Short answers are fine; long evidence blocks "
        "are truncated by the context window. Expect a few tokens per second on "
        "a modern CPU.",
    ),
    "B": ModelProfile(
        "B", "qwen2.5:7b-instruct", "7.6 B", "32 768 tokens", "~4.7 GB",
        "Apache 2.0",
        "Recommended profile. Best balance of scientific explanation, instruction "
        "following and memory use. Runs on CPU or a 6–8 GB GPU.",
    ),
    "C": ModelProfile(
        "C", "qwen2.5:14b-instruct", "14.7 B", "32 768 tokens", "~9.0 GB",
        "Apache 2.0",
        "High-performance profile. Better reasoning, but needs a larger GPU or "
        "more RAM; on CPU it is slow enough that short answers are advisable.",
    ),
}


class RuntimeUnavailable(RuntimeError):
    """Ollama is not reachable or the selected model is not installed."""


def _ram_gb() -> float | None:
    try:
        if sys.platform == "win32":
            class MEMORYSTATUSEX(ctypes.Structure):
                _fields_ = [
                    ("dwLength", ctypes.c_ulong),
                    ("dwMemoryLoad", ctypes.c_ulong),
                    ("ullTotalPhys", ctypes.c_ulonglong),
                    ("ullAvailPhys", ctypes.c_ulonglong),
                    ("ullTotalPageFile", ctypes.c_ulonglong),
                    ("ullAvailPageFile", ctypes.c_ulonglong),
                    ("ullTotalVirtual", ctypes.c_ulonglong),
                    ("ullAvailVirtual", ctypes.c_ulonglong),
                    ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
                ]

            stat = MEMORYSTATUSEX()
            stat.dwLength = ctypes.sizeof(MEMORYSTATUSEX)
            if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(stat)):
                return round(stat.ullTotalPhys / 1024**3, 1)
            return None
        if sys.platform.startswith("linux"):
            with open("/proc/meminfo", encoding="ascii") as fh:
                for line in fh:
                    if line.startswith("MemTotal:"):
                        return round(int(line.split()[1]) / 1024**2, 1)
            return None
        if sys.platform == "darwin":
            out = subprocess.run(
                ["sysctl", "-n", "hw.memsize"], capture_output=True, text=True, timeout=3
            )
            return round(int(out.stdout.strip()) / 1024**3, 1)
    except Exception:  # noqa: BLE001 - detection is best-effort
        return None
    return None


def hardware() -> dict[str, object]:
    ram = _ram_gb()
    profile = "B"
    if ram is not None and ram < 12:
        profile = "A"
    elif ram is not None and ram >= 24:
        profile = "C"
    disk = None
    try:
        disk = round(shutil.disk_usage(".").free / 1024**3, 1)
    except OSError:
        pass
    chosen = PROFILES[profile]
    return {
        "platform": platform.platform(),
        "python": platform.python_version(),
        "cpuCount": os.cpu_count(),
        "ramGB": ram,
        "freeDiskGB": disk,
        "gpu": "not queried — acceleration is decided by the local Ollama runtime",
        "recommendedProfile": profile,
        "recommendedModel": chosen.model,
        "profileNote": chosen.note,
        "caveat": "This is a recommendation from RAM and CPU count, not a benchmark. "
                  "A model that fits may still be slow on a given machine.",
    }


def _get(path: str, timeout: float = 3.0) -> dict | None:
    try:
        with urllib.request.urlopen(f"{OLLAMA_URL}{path}", timeout=timeout) as resp:  # noqa: S310
            return json.loads(resp.read().decode("utf-8", "replace"))
    except (urllib.error.URLError, TimeoutError, OSError, json.JSONDecodeError):
        return None


def installed_models() -> list[str]:
    payload = _get("/api/tags")
    if not payload:
        return []
    models = payload.get("models") or []
    return [m.get("name", "") for m in models if isinstance(m, dict) and m.get("name")]


def status(model: str | None = None) -> dict[str, object]:
    selected = model or DEFAULT_MODEL
    models = installed_models()
    available = bool(models) or _get("/api/version") is not None
    return {
        "runtime": "Ollama",
        "endpoint": OLLAMA_URL,
        "available": available,
        "selectedModel": selected,
        "selectedInstalled": selected in models or any(
            m.split(":")[0] == selected.split(":")[0] and ":" not in selected for m in models
        ),
        "installedModels": models,
        "hardware": hardware(),
        "profiles": {k: v.__dict__ for k, v in PROFILES.items()},
        "fineTuned": False,
        "preparation": "pretrained base model + FIREWATCH system instructions + local knowledge base and retrieval",
        "note": (
            "Weights are not bundled and are never downloaded silently. Install with "
            "`ollama pull qwen2.5:7b-instruct` (or the model for your profile)."
            if not available else
            "A local runtime answered on loopback. Inference happens on this machine."
        ),
    }


def _post_chat(payload: dict) -> urllib.request.Request:
    return urllib.request.Request(
        f"{OLLAMA_URL}/api/chat",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", "Accept": "application/x-ndjson"},
        method="POST",
    )


def stream_chat(
    messages: list[dict[str, str]], model: str | None = None, temperature: float = 0.2
) -> Iterator[str]:
    """Yield content deltas from the local runtime. Raises RuntimeUnavailable."""
    selected = model or DEFAULT_MODEL
    models = installed_models()
    if not models:
        raise RuntimeUnavailable(
            "No local model is installed. Start Ollama and run "
            f"`ollama pull {selected}`, then reload this page."
        )
    if selected not in models:
        raise RuntimeUnavailable(
            f"The model '{selected}' is not installed locally. Installed: {', '.join(models)}. "
            f"Install it with `ollama pull {selected}`."
        )
    payload = {
        "model": selected,
        "messages": messages,
        "stream": True,
        "options": {"temperature": temperature, "num_ctx": 8192},
    }
    try:
        with urllib.request.urlopen(_post_chat(payload), timeout=180) as resp:  # noqa: S310
            for raw in resp:
                line = raw.decode("utf-8", "replace").strip()
                if not line:
                    continue
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if event.get("error"):
                    raise RuntimeUnavailable(str(event["error"])[:300])
                piece = (event.get("message") or {}).get("content")
                if piece:
                    yield piece
                if event.get("done"):
                    return
    except urllib.error.URLError as exc:
        raise RuntimeUnavailable(
            f"The local runtime at {OLLAMA_URL} did not answer ({exc.reason}). "
            "Start Ollama and try again; the knowledge base still works without it."
        ) from exc
