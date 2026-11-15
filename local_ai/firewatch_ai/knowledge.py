"""Local scientific knowledge base + retrieval.

Storage: one SQLite file (`data/knowledge.db`) with an FTS5 table. FTS5 is part
of the Python standard library build on Windows/macOS/Linux, so the bundle needs
no third-party dependency and no embedding model download.

Retrieval is lexical (BM25 via FTS5) with a cosine re-rank on TF-IDF vectors of
the top candidates. That is honest: it is *not* a neural embedding retriever,
and the UI says "lexical retrieval" rather than claiming semantic search.

Provenance travels with every chunk: title, source, url, document version and a
SHA-256 of the chunk text. Duplicate chunks (the same text in two documents) are
collapsed by that hash, and the build reports how many were dropped.
"""
from __future__ import annotations

import hashlib
import math
import re
import sqlite3
from contextlib import closing
from dataclasses import dataclass
from pathlib import Path

CHUNK_CHARS = 900
CHUNK_OVERLAP = 120
STOPWORDS = set(
    "a an and are as at be by for from has have how in into is it its of on or "
    "that the their there these this to was were what when where which who why "
    "with not no can could should would may might do does did".split()
)


@dataclass
class Chunk:
    id: int
    doc_id: str
    title: str
    text: str
    source: str
    url: str
    version: str
    sha256: str
    score: float = 0.0


def _tokenise(text: str) -> list[str]:
    return [t for t in re.findall(r"[a-z0-9]+", text.lower()) if t not in STOPWORDS and len(t) > 2]


def _front_matter(text: str) -> tuple[dict[str, str], str]:
    if not text.startswith("---"):
        return {}, text
    parts = text.split("---", 2)
    if len(parts) < 3:
        return {}, text
    meta: dict[str, str] = {}
    for line in parts[1].splitlines():
        if ":" in line:
            key, value = line.split(":", 1)
            meta[key.strip()] = value.strip()
    return meta, parts[2].strip()


def _chunks(body: str) -> list[str]:
    paragraphs = [p.strip() for p in re.split(r"\n\s*\n", body) if p.strip()]
    out: list[str] = []
    buf = ""
    for para in paragraphs:
        if len(buf) + len(para) + 2 <= CHUNK_CHARS:
            buf = f"{buf}\n\n{para}".strip()
        else:
            if buf:
                out.append(buf)
            if len(para) <= CHUNK_CHARS:
                buf = para
            else:
                start = 0
                while start < len(para):
                    out.append(para[start : start + CHUNK_CHARS])
                    start += CHUNK_CHARS - CHUNK_OVERLAP
                buf = ""
    if buf:
        out.append(buf)
    return out


class KnowledgeBase:
    def __init__(self, db_path: Path, docs_dir: Path):
        self.db_path = Path(db_path)
        self.docs_dir = Path(docs_dir)

    def _connect(self) -> sqlite3.Connection:
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        return conn

    def ensure(self) -> dict[str, int]:
        """(Re)index the shipped documents. Idempotent; reports real counts."""
        with closing(self._connect()) as conn, conn:
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute(
                "CREATE TABLE IF NOT EXISTS docs ("
                " doc_id TEXT PRIMARY KEY, title TEXT, source TEXT, url TEXT,"
                " version TEXT, path TEXT, sha256 TEXT)"
            )
            conn.execute(
                "CREATE TABLE IF NOT EXISTS chunks ("
                " id INTEGER PRIMARY KEY AUTOINCREMENT, doc_id TEXT, title TEXT,"
                " text TEXT, sha256 TEXT UNIQUE, source TEXT, url TEXT, version TEXT)"
            )
            conn.execute(
                "CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5("
                " text, title, doc_id UNINDEXED, chunk_id UNINDEXED)"
            )
            conn.execute("DELETE FROM chunks_fts")
            conn.execute("DELETE FROM chunks")
            conn.execute("DELETE FROM docs")

            seen: set[str] = set()
            added = duplicates = docs = 0
            for path in sorted(self.docs_dir.glob("*.md")):
                raw = path.read_text(encoding="utf-8")
                meta, body = _front_matter(raw)
                doc_id = path.stem
                title = meta.get("title", doc_id.replace("_", " "))
                source = meta.get("source", "FIREWATCH knowledge base")
                url = meta.get("url", "")
                version = meta.get("version", "unversioned")
                doc_sha = hashlib.sha256(raw.encode("utf-8")).hexdigest()
                conn.execute(
                    "INSERT INTO docs(doc_id,title,source,url,version,path,sha256)"
                    " VALUES(?,?,?,?,?,?,?)",
                    (doc_id, title, source, url, version, str(path), doc_sha),
                )
                docs += 1
                for text in _chunks(body):
                    sha = hashlib.sha256(text.encode("utf-8")).hexdigest()
                    if sha in seen:  # duplicate detection across documents
                        duplicates += 1
                        continue
                    seen.add(sha)
                    cur = conn.execute(
                        "INSERT INTO chunks(doc_id,title,text,sha256,source,url,version)"
                        " VALUES(?,?,?,?,?,?,?)",
                        (doc_id, title, text, sha, source, url, version),
                    )
                    conn.execute(
                        "INSERT INTO chunks_fts(text,title,doc_id,chunk_id) VALUES(?,?,?,?)",
                        (text, title, doc_id, cur.lastrowid),
                    )
                    added += 1
            conn.commit()
        return {"documents": docs, "chunks": added, "duplicatesDropped": duplicates}

    def stats(self) -> dict[str, int]:
        with closing(self._connect()) as conn, conn:
            docs = conn.execute("SELECT COUNT(*) FROM docs").fetchone()[0]
            chunks = conn.execute("SELECT COUNT(*) FROM chunks").fetchone()[0]
        return {"documents": int(docs), "chunks": int(chunks)}

    def search(self, query: str, k: int = 4) -> list[Chunk]:
        terms = _tokenise(query)
        if not terms:
            return []
        match = " OR ".join(f'"{t}"' for t in terms[:12])
        with closing(self._connect()) as conn, conn:
            try:
                rows = conn.execute(
                    "SELECT c.id, c.doc_id, c.title, c.text, c.source, c.url, c.version,"
                    " c.sha256, bm25(chunks_fts) AS rank"
                    " FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.chunk_id"
                    " WHERE chunks_fts MATCH ? ORDER BY rank LIMIT ?",
                    (match, max(k * 4, 12)),
                ).fetchall()
            except sqlite3.OperationalError:
                rows = []
            if not rows:
                # FTS5 expression errors (quotes/punctuation) must not break chat.
                like = f"%{query.strip()[:60]}%"
                rows = conn.execute(
                    "SELECT id, doc_id, title, text, source, url, version, sha256,"
                    " 0.0 AS rank FROM chunks WHERE text LIKE ? LIMIT ?",
                    (like, max(k * 4, 12)),
                ).fetchall()

        cand = [
            Chunk(
                id=r["id"], doc_id=r["doc_id"], title=r["title"], text=r["text"],
                source=r["source"], url=r["url"], version=r["version"], sha256=r["sha256"],
            )
            for r in rows
        ]
        ranked = _cosine_rerank(query, cand)
        return ranked[:k]


def _cosine_rerank(query: str, chunks: list[Chunk]) -> list[Chunk]:
    """TF-IDF cosine on the candidate set. Deterministic and dependency-free."""
    q_terms = _tokenise(query)
    if not q_terms or not chunks:
        return chunks
    docs = [_tokenise(c.text) for c in chunks]
    vocabulary = sorted(set(q_terms).union(*[set(d) for d in docs]))
    index = {term: i for i, term in enumerate(vocabulary)}
    n = len(docs)
    df = [sum(1 for d in docs if term in d) for term in vocabulary]
    idf = [math.log((n + 1) / (count + 1)) + 1.0 for count in df]

    def vector(tokens: list[str]) -> list[float]:
        counts = [0.0] * len(vocabulary)
        for token in tokens:
            counts[index[token]] += 1.0
        return [counts[i] * idf[i] for i in range(len(vocabulary))]

    qv = vector(q_terms)
    qnorm = math.sqrt(sum(v * v for v in qv)) or 1.0
    scored = []
    for chunk, tokens in zip(chunks, docs):
        dv = vector(tokens)
        dnorm = math.sqrt(sum(v * v for v in dv)) or 1.0
        score = sum(a * b for a, b in zip(qv, dv)) / (qnorm * dnorm)
        chunk.score = round(score, 4)
        scored.append(chunk)
    scored.sort(key=lambda c: c.score, reverse=True)
    return scored


def citations(chunks: list[Chunk]) -> list[dict[str, object]]:
    """The [K1] … list the UI renders under an answer."""
    return [
        {
            "label": f"K{i + 1}",
            "title": c.title,
            "source": c.source,
            "url": c.url,
            "version": c.version,
            "score": c.score,
            "excerpt": c.text[:280].replace("\n", " "),
        }
        for i, c in enumerate(chunks)
    ]
