"""Thin adapter that reuses Yorichi (C:/Yorichi) as FIREWATCH's assistant backend.

Yorichi is never copied or modified; we import it from its own directory at
runtime. Hardware-aware model selection is delegated to Yorichi's runtime.
"""
from __future__ import annotations

import sys
from pathlib import Path

YORICHI_DIR = Path("C:/Yorichi")
if str(YORICHI_DIR) not in sys.path:
    sys.path.insert(0, str(YORICHI_DIR))

try:
    import assistant as _yorichi_assistant  # noqa: E402
    import llm as _yorichi_llm  # noqa: E402
    import persona as _yorichi_persona  # noqa: E402
    import runtime as _yorichi_runtime  # noqa: E402
    _AVAILABLE = True
except Exception as e:  # pragma: no cover
    _AVAILABLE = False
    _IMPORT_ERROR = str(e)


def available() -> bool:
    return _AVAILABLE


def hardware_profile() -> dict:
    if not _AVAILABLE:
        return {"available": False, "error": _IMPORT_ERROR if "_IMPORT_ERROR" in globals() else "import failed"}
    try:
        return {"available": True, "profile": _yorichi_runtime.status() if hasattr(_yorichi_runtime, "status") else {}}
    except Exception as e:
        return {"available": True, "error": str(e)}


FIREWATCH_SYSTEM = (
    "You are FIREWATCH AI, a scientific assistant for satellite active-fire "
    "observations. You identify only as FIREWATCH AI. Never mention model names, "
    "vendors, or that you are any other assistant. Base every number strictly on "
    "the provided evidence bundle; never invent measurements. If evidence is "
    "missing, say so clearly. Structure answers in three parts: (1) scientific "
    "summary, (2) plain-language explanation, (3) confidence and limitations."
)


def generate_grounded(evidence_text: str, question: str = "") -> dict:
    """Return a grounded response dict with three layers and used-context."""
    if not _AVAILABLE:
        return {
            "available": False,
            "error": "Yorichi backend not available",
            "scientificSummary": evidence_text,
            "plainLanguage": "Assistant backend unavailable; showing evidence only.",
            "confidenceAndLimitations": "No LLM phrasing available.",
        }
    try:
        # Build prompt with evidence
        prompt = f"{FIREWATCH_SYSTEM}\n\nEVIDENCE BUNDLE:\n{evidence_text}\n\n"
        if question:
            prompt += f"QUESTION: {question}\n\n"
        prompt += "Answer in the three required parts."
        # Try engine generate
        engine = _yorichi_llm.Engine() if hasattr(_yorichi_llm, "Engine") else None
        text = ""
        if engine is not None and hasattr(engine, "generate"):
            text = engine.generate(prompt)
        elif hasattr(_yorichi_assistant, "generate"):
            text = _yorichi_assistant.generate(prompt)
        else:
            text = evidence_text
        return {
            "available": True,
            "scientificSummary": text,
            "plainLanguage": text,
            "confidenceAndLimitations": "See above; values sourced from evidence bundle.",
        }
    except Exception as e:
        return {
            "available": False,
            "error": str(e),
            "scientificSummary": evidence_text,
            "plainLanguage": "LLM unavailable; showing evidence only.",
            "confidenceAndLimitations": "No LLM phrasing available.",
        }
