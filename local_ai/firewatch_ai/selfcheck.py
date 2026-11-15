"""First-run diagnostic.

Prints one PASS/FAIL line per layer so a user can see exactly what is ready
before they trust an answer. Exit code 1 means at least one required layer is
missing; a missing model is reported as a warning, not a failure, because the
knowledge base still answers without it.
"""
from __future__ import annotations

import sys
from pathlib import Path

from . import FINETUNED, PRODUCT, TAGLINE, VERSION
from .knowledge import KnowledgeBase
from .persona import PERSONA_VERSION, build_system_prompt
from .runtime import status as runtime_status
from .store import Store

BASE = Path(__file__).resolve().parent.parent
DATA = BASE / "data"


def main() -> int:
    print(f"{PRODUCT} - {TAGLINE}")
    print(f"version {VERSION} | persona {PERSONA_VERSION} | fine-tuned: {FINETUNED}\n")
    failures = 0

    try:
        kb = KnowledgeBase(DATA / "knowledge.db", BASE / "knowledge")
        stats = kb.ensure()
        hits = kb.search("fire radiative power", k=3)
        ok = stats["chunks"] > 0 and len(hits) > 0
        print(f"[{'PASS' if ok else 'FAIL'}] knowledge base | {stats['documents']} docs | "
              f"{stats['chunks']} chunks | {len(hits)} retrieved")
        failures += 0 if ok else 1
    except Exception as exc:  # noqa: BLE001
        print(f"[FAIL] knowledge base | {exc}")
        failures += 1

    try:
        store = Store(DATA / "firewatch_local.db")
        store.ensure()
        conversation = store.create_conversation("selfcheck")
        store.add_message(conversation["id"], "user", "ping")
        read = store.get_conversation(conversation["id"])
        ok = read is not None and len(read["messages"]) == 1
        store.delete_conversation(conversation["id"])
        print(f"[{'PASS' if ok else 'FAIL'}] local conversation store | read/write/delete")
        failures += 0 if ok else 1
    except Exception as exc:  # noqa: BLE001
        print(f"[FAIL] conversation store | {exc}")
        failures += 1

    prompt = build_system_prompt(["selfcheck memory"])
    rules = ["FIREWATCH AI", "not a confirmed wildfire", "Never invent a measurement"]
    ok = all(r in prompt for r in rules)
    print(f"[{'PASS' if ok else 'FAIL'}] system instructions | identity and grounding rules present")
    failures += 0 if ok else 1

    status = runtime_status()
    hw = status["hardware"]
    print(f"[INFO] hardware | {hw['cpuCount']} CPU | {hw['ramGB']} GB RAM | "
          f"profile {hw['recommendedProfile']} -> {hw['recommendedModel']}")
    if status["available"] and status["selectedInstalled"]:
        print(f"[PASS] local runtime | {status['endpoint']} | {status['selectedModel']} installed")
    elif status["available"]:
        print(f"[WARN] local runtime reachable, model not installed | "
              f"run: ollama pull {status['selectedModel']}")
    else:
        print(f"[WARN] local runtime not reachable at {status['endpoint']} | "
              "answers will come from the knowledge base and say so")

    print("\nRESULT:", "ready" if failures == 0 else f"{failures} required layer(s) failed")
    return 0 if failures == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
