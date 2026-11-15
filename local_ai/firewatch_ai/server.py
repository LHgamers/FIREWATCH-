"""FIREWATCH AI Local Edition — loopback HTTP server + chat API.

Bound to 127.0.0.1 by default. There is no public listener, no telemetry and no
account. The browser UI is served from `web/index.html`.

Security posture
----------------
* Host header must be a loopback hostname with the configured port; anything
  else is rejected with 403 (DNS-rebinding defence).
* No wildcard CORS. `FIREWATCH_ALLOWED_ORIGINS` defaults to
  `http://localhost:3000,http://127.0.0.1:3000`, so the FIREWATCH website can
  call this companion only from the documented dev/production origins.
* Request bodies are JSON, size-capped at 256 KB, and validated field by field.
* No shell execution, no filesystem paths from the client, no model downloads.
* Deletes require `confirm=true`.

Endpoints
---------
GET    /                       chat UI
GET    /api/status             runtime, hardware suggestion, KB stats
GET    /api/conversations      list
POST   /api/conversations      create
GET    /api/conversations/{id} read
DELETE /api/conversations/{id}?confirm=true
POST   /api/chat               SSE: meta, delta, done, error
POST   /api/remember           store one user fact
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import threading
import time
import webbrowser
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

from . import PRODUCT, TAGLINE, VERSION
from .knowledge import KnowledgeBase, citations
from .persona import PERSONA_VERSION, build_system_prompt
from .runtime import RuntimeUnavailable, status as runtime_status, stream_chat
from .store import Store

BASE = Path(__file__).resolve().parent.parent
WEB = BASE / "web"
DATA = Path(os.environ.get("FIREWATCH_AI_DATA", BASE / "data"))
PORT = int(os.environ.get("FIREWATCH_AI_PORT", "8020"))
HOST = os.environ.get("FIREWATCH_AI_HOST", "127.0.0.1")
ALLOWED_ORIGINS = {
    o.strip()
    for o in os.environ.get(
        "FIREWATCH_ALLOWED_ORIGINS",
        "http://localhost:3000,http://127.0.0.1:3000,http://localhost:8020,http://127.0.0.1:8020",
    ).split(",")
    if o.strip()
}
MAX_BODY = 256 * 1024
MAX_MESSAGE = 4000
CONTEXT_CHARS = 3200

KB = KnowledgeBase(DATA / "knowledge.db", BASE / "knowledge")
STORE = Store(DATA / "firewatch_local.db")
_started = time.time()


def _log(message: str) -> None:
    print(f"[firewatch-ai] {message}", flush=True)


def _fallback_answer(question: str, chunks: list[dict[str, Any]], reason: str) -> str:
    """Deterministic, citation-backed answer used when no model is available."""
    head = (
        "**Local model runtime unavailable.** " + reason + "\n\n"
        "This answer is composed from the installed knowledge base only — no model was run.\n\n"
    )
    if not chunks:
        return head + (
            "No matching document was found in the local knowledge base either. "
            "I will not guess: connect the local runtime, or ask about MODIS, VIIRS, FRP, "
            "confidence, harmonization, the Burning Activity Calendar or coverage states."
        )
    body = "\n\n".join(
        f"**[{c['label']}] {c['title']}**\n\n{c['excerpt']}" for c in chunks[:2]
    )
    tail = (
        "\n\nThis is retrieved documentation, not an inference. Start Ollama and pull the "
        "model shown in Settings for a synthesised explanation."
    )
    return head + body + tail


def _sse(payload: dict[str, Any]) -> bytes:
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n".encode("utf-8")


class Handler(BaseHTTPRequestHandler):
    server_version = f"FIREWATCH-AI-Local/{VERSION}"
    protocol_version = "HTTP/1.1"

    # -------------------------------------------------------------- plumbing
    def log_message(self, fmt: str, *args: Any) -> None:  # noqa: A003
        if os.environ.get("FIREWATCH_AI_QUIET") != "1":
            _log(f"{self.address_string()} {fmt % args}")

    def _origin_allowed(self) -> bool:
        origin = self.headers.get("Origin")
        return origin is None or origin in ALLOWED_ORIGINS

    def _host_ok(self) -> bool:
        host = (self.headers.get("Host") or "").lower()
        return host in {f"127.0.0.1:{PORT}", f"localhost:{PORT}", f"[::1]:{PORT}"}

    def _cors(self) -> None:
        origin = self.headers.get("Origin")
        if origin in ALLOWED_ORIGINS:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _json(self, status: int, payload: dict[str, Any] | list[Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def _error(self, status: int, message: str) -> None:
        self._json(status, {"detail": message})

    def _body(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return {}
        if length > MAX_BODY:
            raise ValueError("request body is larger than 256 KB")
        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ValueError("body must be valid JSON") from exc
        if not isinstance(payload, dict):
            raise ValueError("body must be a JSON object")
        return payload

    # ----------------------------------------------------------------- routes
    def do_OPTIONS(self) -> None:  # noqa: N802
        if not self._host_ok() or not self._origin_allowed():
            self.send_response(HTTPStatus.FORBIDDEN)
            self.end_headers()
            return
        self.send_response(HTTPStatus.NO_CONTENT)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        if not self._host_ok():
            self._error(HTTPStatus.FORBIDDEN, "loopback host required")
            return
        if not self._origin_allowed():
            self._error(HTTPStatus.FORBIDDEN, "origin not allowed")
            return
        parsed = urlparse(self.path)
        path = parsed.path

        if path in ("/", "/index.html"):
            html = (WEB / "index.html").read_bytes()
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(html)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header(
                "Content-Security-Policy",
                "default-src 'self'; script-src 'self' 'unsafe-inline'; "
                "style-src 'self' 'unsafe-inline'; img-src 'self' data:; "
                "connect-src 'self'",
            )
            self.end_headers()
            self.wfile.write(html)
            return

        if path == "/api/status":
            self._json(HTTPStatus.OK, {
                "product": PRODUCT,
                "tagline": TAGLINE,
                "version": VERSION,
                "personaVersion": PERSONA_VERSION,
                "runtime": runtime_status(),
                "knowledge": KB.stats(),
                "conversations": len(STORE.list_conversations()),
                "uptimeSeconds": int(time.time() - _started),
                "privacy": "Conversations and memories stay in data/firewatch_local.db on this machine. No telemetry.",
                "fineTuned": False,
            })
            return

        if path == "/api/conversations":
            self._json(HTTPStatus.OK, {"conversations": STORE.list_conversations()})
            return

        if path.startswith("/api/conversations/"):
            cid = path.rsplit("/", 1)[-1]
            conversation = STORE.get_conversation(cid)
            if conversation is None:
                self._error(HTTPStatus.NOT_FOUND, "conversation not found")
                return
            self._json(HTTPStatus.OK, conversation)
            return

        if path == "/api/health":
            self._json(HTTPStatus.OK, {"status": "ok", "version": VERSION})
            return

        self._error(HTTPStatus.NOT_FOUND, "unknown endpoint")

    def do_POST(self) -> None:  # noqa: N802
        if not self._host_ok() or not self._origin_allowed():
            self._error(HTTPStatus.FORBIDDEN, "origin or host not allowed")
            return
        path = urlparse(self.path).path
        try:
            body = self._body()
        except ValueError as exc:
            self._error(HTTPStatus.BAD_REQUEST, str(exc))
            return

        if path == "/api/conversations":
            title = body.get("title")
            title = title.strip()[:80] if isinstance(title, str) and title.strip() else "New conversation"
            self._json(HTTPStatus.CREATED, STORE.create_conversation(title))
            return

        if path == "/api/remember":
            value = body.get("value")
            if not isinstance(value, str) or not value.strip():
                self._error(HTTPStatus.BAD_REQUEST, "value is required")
                return
            STORE.remember(value)
            self._json(HTTPStatus.OK, {"ok": True, "note": "Stored locally in memory."})
            return

        if path == "/api/chat":
            self._chat(body)
            return

        self._error(HTTPStatus.NOT_FOUND, "unknown endpoint")

    def do_DELETE(self) -> None:  # noqa: N802
        if not self._host_ok() or not self._origin_allowed():
            self._error(HTTPStatus.FORBIDDEN, "origin or host not allowed")
            return
        parsed = urlparse(self.path)
        if not parsed.path.startswith("/api/conversations/"):
            self._error(HTTPStatus.NOT_FOUND, "unknown endpoint")
            return
        confirm = (parse_qs(parsed.query).get("confirm") or ["false"])[0] == "true"
        if not confirm:
            self._error(HTTPStatus.BAD_REQUEST, "set confirm=true to delete a conversation")
            return
        cid = parsed.path.rsplit("/", 1)[-1]
        ok = STORE.delete_conversation(cid)
        self._json(HTTPStatus.OK if ok else HTTPStatus.NOT_FOUND,
                   {"deleted": ok, "id": cid})

    # ------------------------------------------------------------------- chat
    def _chat(self, body: dict[str, Any]) -> None:
        message = body.get("message")
        if not isinstance(message, str) or not message.strip():
            self._error(HTTPStatus.BAD_REQUEST, "message is required")
            return
        message = message.strip()
        if len(message) > MAX_MESSAGE:
            self._error(HTTPStatus.BAD_REQUEST, f"message is longer than {MAX_MESSAGE} characters")
            return

        cid = body.get("conversationId")
        if not isinstance(cid, str) or not cid:
            conversation = STORE.create_conversation(message[:60])
        else:
            conversation = STORE.get_conversation(cid)
            if conversation is None:
                self._error(HTTPStatus.NOT_FOUND, "conversation not found")
                return
        cid = conversation["id"]

        model = body.get("model") if isinstance(body.get("model"), str) else None
        regenerate = body.get("regenerate") is True
        evidence = body.get("evidence") if isinstance(body.get("evidence"), str) else ""
        evidence = evidence[:6000]

        # Long-term memory: only an explicit "remember that …" instruction is stored.
        if re.match(r"^\s*remember\b", message, re.IGNORECASE):
            fact = re.sub(r"^\s*remember(\s+that)?[\s:,-]*", "", message, flags=re.IGNORECASE)
            if fact.strip():
                STORE.remember(fact)

        chunks = KB.search(message, k=4)
        cites = citations(chunks)
        if conversation["messages"] == []:
            STORE.touch(cid, message[:60])

        # A regenerate repeats the question; it is not a new user turn, so the
        # stored transcript keeps one copy of what the user actually typed.
        if not regenerate:
            STORE.add_message(cid, "user", message, {"evidence": bool(evidence)})

        context = "\n\n".join(
            f"[K{i + 1}] {c.title} ({c.source}, {c.version})\n{c.text}"
            for i, c in enumerate(chunks)
        )[:CONTEXT_CHARS]
        system = build_system_prompt(STORE.memories())
        if context:
            system += (
                "\n\n## Retrieved documents for this turn\n"
                "Cite them as [K1], [K2] … when you use them. If they do not answer the "
                "question, say so rather than filling the gap from memory.\n\n"
                + context
            )
        if evidence:
            system += "\n\n## Evidence block supplied by the FIREWATCH website\n" + evidence

        history = STORE.history(cid, limit=10)
        messages = [{"role": "system", "content": system}]
        messages += [m for m in history if m["role"] in ("user", "assistant")]

        # SSE has no declared length. HTTP/1.0-style close-delimited streaming
        # is unambiguous for every client; an HTTP/1.1 response without
        # Content-Length or chunked framing is discarded by curl and some fetch
        # implementations.
        self.protocol_version = "HTTP/1.0"
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self._cors()
        self.end_headers()
        self.close_connection = True

        def emit(payload: dict[str, Any]) -> bool:
            try:
                self.wfile.write(_sse(payload))
                self.wfile.flush()
                return True
            except (BrokenPipeError, ConnectionResetError):
                return False

        emit({
            "type": "meta",
            "conversationId": cid,
            "model": model or None,
            "citations": cites,
            "retrieved": [c["label"] for c in cites],
            "knowledgeStats": KB.stats(),
        })

        answer_parts: list[str] = []
        mode = "llm"
        try:
            for delta in stream_chat(messages, model=model):
                answer_parts.append(delta)
                if not emit({"type": "delta", "text": delta}):
                    break
        except RuntimeUnavailable as exc:
            mode = "knowledge-only"
            answer = _fallback_answer(message, cites, str(exc))
            answer_parts = [answer]
            emit({"type": "notice", "text": str(exc)})
            # Stream the fallback in small pieces so the UI behaves identically.
            for i in range(0, len(answer), 240):
                if not emit({"type": "delta", "text": answer[i : i + 240]}):
                    break
        finally:
            text = "".join(answer_parts).strip()
            if text:
                STORE.add_message(cid, "assistant", text,
                                  {"mode": mode, "citations": [c["label"] for c in cites]})
            emit({
                "type": "done",
                "mode": mode,
                "conversationId": cid,
                "citations": cites,
                "chars": len(text),
                "note": (
                    "Generated locally by " + (model or "the configured local model")
                    if mode == "llm" else
                    "No model was run; this answer is retrieved documentation only."
                ),
            })


def main(argv: list[str] | None = None) -> int:
    global PORT
    parser = argparse.ArgumentParser(description=f"{PRODUCT} — {TAGLINE}")
    parser.add_argument("--port", type=int, default=PORT)
    parser.add_argument("--no-browser", action="store_true")
    parser.add_argument("--reindex", action="store_true")
    args = parser.parse_args(argv)

    PORT = args.port
    STORE.ensure()
    stats = KB.ensure()
    _log(f"knowledge base: {stats}")
    _log(f"{PRODUCT} v{VERSION} listening on http://{HOST}:{PORT} (loopback only)")
    if not args.no_browser:
        threading.Timer(0.8, lambda: webbrowser.open(f"http://{HOST}:{PORT}/")).start()
    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        _log("stopped")
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
