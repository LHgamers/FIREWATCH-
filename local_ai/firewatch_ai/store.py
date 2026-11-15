"""Local conversation + memory storage (SQLite, on the user's disk only).

Nothing in this module opens a network socket. There is no telemetry. Deleting
`data/firewatch_local.db` removes every conversation and remembered fact.

Tables:
  conversations(id, title, created_at, updated_at)
  messages(id, conversation_id, role, content, meta, created_at)
  memory(id, key, value, created_at)

A conversation delete is a hard delete with its messages, guarded by
`confirm=true` at the HTTP layer so an accidental click cannot destroy history.
"""
from __future__ import annotations

import json
import sqlite3
from contextlib import closing
import time
import uuid
from pathlib import Path
from typing import Any


def _now() -> int:
    return int(time.time() * 1000)


class Store:
    def __init__(self, db_path: Path):
        self.db_path = Path(db_path)

    def _connect(self) -> sqlite3.Connection:
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        return conn

    def ensure(self) -> None:
        with closing(self._connect()) as conn, conn:
            conn.execute(
                "CREATE TABLE IF NOT EXISTS conversations ("
                " id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at INTEGER NOT NULL,"
                " updated_at INTEGER NOT NULL)"
            )
            conn.execute(
                "CREATE TABLE IF NOT EXISTS messages ("
                " id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id TEXT NOT NULL,"
                " role TEXT NOT NULL, content TEXT NOT NULL, meta TEXT,"
                " created_at INTEGER NOT NULL,"
                " FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE)"
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS messages_by_conversation"
                " ON messages(conversation_id, id)"
            )
            conn.execute(
                "CREATE TABLE IF NOT EXISTS memory ("
                " id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT, value TEXT NOT NULL,"
                " created_at INTEGER NOT NULL)"
            )
            conn.commit()

    # ------------------------------------------------------------ conversations
    def create_conversation(self, title: str = "New conversation") -> dict[str, Any]:
        cid = uuid.uuid4().hex
        now = _now()
        with closing(self._connect()) as conn, conn:
            conn.execute(
                "INSERT INTO conversations(id,title,created_at,updated_at) VALUES(?,?,?,?)",
                (cid, title[:120], now, now),
            )
            conn.commit()
        return {"id": cid, "title": title[:120], "createdAt": now, "updatedAt": now}

    def list_conversations(self) -> list[dict[str, Any]]:
        with closing(self._connect()) as conn, conn:
            rows = conn.execute(
                "SELECT c.id, c.title, c.created_at, c.updated_at,"
                " (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS n"
                " FROM conversations c ORDER BY c.updated_at DESC"
            ).fetchall()
        return [
            {"id": r["id"], "title": r["title"], "createdAt": r["created_at"],
             "updatedAt": r["updated_at"], "messages": r["n"]}
            for r in rows
        ]

    def get_conversation(self, cid: str) -> dict[str, Any] | None:
        with closing(self._connect()) as conn, conn:
            c = conn.execute("SELECT * FROM conversations WHERE id=?", (cid,)).fetchone()
            if not c:
                return None
            rows = conn.execute(
                "SELECT id, role, content, meta, created_at FROM messages"
                " WHERE conversation_id=? ORDER BY id",
                (cid,),
            ).fetchall()
        return {
            "id": c["id"],
            "title": c["title"],
            "createdAt": c["created_at"],
            "updatedAt": c["updated_at"],
            "messages": [
                {
                    "id": r["id"], "role": r["role"], "content": r["content"],
                    "meta": json.loads(r["meta"]) if r["meta"] else None,
                    "createdAt": r["created_at"],
                }
                for r in rows
            ],
        }

    def delete_conversation(self, cid: str) -> bool:
        with closing(self._connect()) as conn, conn:
            cur = conn.execute("DELETE FROM conversations WHERE id=?", (cid,))
            conn.execute("DELETE FROM messages WHERE conversation_id=?", (cid,))
            conn.commit()
        return cur.rowcount > 0

    def touch(self, cid: str, title: str | None = None) -> None:
        with closing(self._connect()) as conn, conn:
            if title:
                conn.execute(
                    "UPDATE conversations SET title=?, updated_at=? WHERE id=?",
                    (title[:120], _now(), cid),
                )
            else:
                conn.execute("UPDATE conversations SET updated_at=? WHERE id=?", (_now(), cid))
            conn.commit()

    def add_message(
        self, cid: str, role: str, content: str, meta: dict[str, Any] | None = None
    ) -> int:
        with closing(self._connect()) as conn, conn:
            cur = conn.execute(
                "INSERT INTO messages(conversation_id,role,content,meta,created_at)"
                " VALUES(?,?,?,?,?)",
                (cid, role, content, json.dumps(meta) if meta else None, _now()),
            )
            conn.execute("UPDATE conversations SET updated_at=? WHERE id=?", (_now(), cid))
            conn.commit()
        return int(cur.lastrowid)

    def history(self, cid: str, limit: int = 12) -> list[dict[str, str]]:
        """Recent turns for the prompt (oldest first)."""
        with closing(self._connect()) as conn, conn:
            rows = conn.execute(
                "SELECT role, content FROM messages WHERE conversation_id=?"
                " ORDER BY id DESC LIMIT ?",
                (cid, max(1, limit)),
            ).fetchall()
        return [{"role": r["role"], "content": r["content"]} for r in reversed(rows)]

    # ------------------------------------------------------------------- memory
    def remember(self, value: str) -> None:
        with closing(self._connect()) as conn, conn:
            conn.execute(
                "INSERT INTO memory(key,value,created_at) VALUES(?,?,?)",
                ("user-fact", value.strip()[:400], _now()),
            )
            conn.commit()

    def memories(self, limit: int = 8) -> list[str]:
        with closing(self._connect()) as conn, conn:
            rows = conn.execute(
                "SELECT value FROM memory ORDER BY id DESC LIMIT ?", (limit,)
            ).fetchall()
        return [r["value"] for r in rows]
