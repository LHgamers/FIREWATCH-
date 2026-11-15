# FIREWATCH AI — Local Edition

**Local Scientific Intelligence by LH STUDIOS · v0.2.0**

A local, offline-capable assistant for satellite active-fire observations. Inference
runs on **your** computer through a locally installed Ollama runtime. This package
never sends your questions, conversations or documents to LH STUDIOS, and there is
no telemetry.

---

## What is actually in this package (honest layering)

| Layer | What it is | Trained here? |
|---|---|---|
| Base model | `qwen2.5:7b-instruct` (Apache 2.0), pulled by **you** from the Ollama registry. Weights are **not** bundled. | No |
| System instructions | `firewatch_ai/persona.py` — identity, scientific scope, grounding rules, citation and refusal policy. Versioned `firewatch-persona-0.2.0`. | No |
| Knowledge base + retrieval | 6 curated documents in `knowledge/`, indexed into SQLite FTS5 (BM25) with a TF-IDF cosine re-rank. Lexical retrieval — not embeddings. | No |
| Fine-tuned weights | **None.** No gradient step was ever applied by LH STUDIOS. | No |

This is a **prepared base model with retrieval-augmented generation**. It is not a
fine-tuned model, and nothing in the UI or the code claims otherwise
(`firewatch_ai.FINETUNED is False`).

---

## Requirements

- Python **3.11+** (standard library only — no pip packages).
- Ollama (<https://ollama.com>) installed and running on loopback.
- A model that fits your machine:

| Profile | Model | Params | Context | Approx. VRAM | Licence |
|---|---|---|---|---|---|
| A · low resource | `llama3.2:3b-instruct` | 3 B | 8 192 | ~2.0 GB | Llama 3.2 Community Licence |
| B · recommended | `qwen2.5:7b-instruct` | 7.6 B | 32 768 | ~4.7 GB | Apache 2.0 |
| C · high performance | `qwen2.5:14b-instruct` | 14.7 B | 32 768 | ~9.0 GB | Apache 2.0 |

The app reads your RAM and CPU count and **suggests** a profile. That is advice, not
a benchmark, and no model is guaranteed to run on a given machine.

---

## Install

**Windows**

```bat
install.bat
ollama pull qwen2.5:7b-instruct
start.bat
```

**macOS / Linux**

```bash
./install.sh
ollama pull qwen2.5:7b-instruct
./start.sh
```

`install.bat` runs a first-run diagnostic (`python -m firewatch_ai.selfcheck`) that
reports PASS/FAIL for the knowledge base, the conversation store, the system
instructions and the local runtime. The model is a warning, not a failure: without
it, answers come from the knowledge base and say so.

Nothing large is downloaded silently. `ollama pull` is the only multi-gigabyte
download, and you run it yourself.

Open <http://127.0.0.1:8020>.

---

## What works, and what does not

**Works offline**
- Answers from the local model with no network connection once the weights are pulled.
- Knowledge-base retrieval with `[K1]`-style citations and source URLs.
- Conversation history and long-term memory in a local SQLite file.
- A deterministic knowledge-only answer when no model runtime is available (clearly labelled).

**Does not work — and says so**
- No live web search. The assistant will not pretend to browse.
- No PDF/DOCX ingestion (no ingestion library is bundled).
- No native tool calls (this model does not reliably emit them).
- No Windows service or auto-start.
- No fine-tuned model.

---

## Privacy

- Conversations: `data/firewatch_local.db` — on your disk only.
- Knowledge index: `data/knowledge.db` — rebuilt from the shipped documents.
- Network: the server binds **127.0.0.1** and refuses non-loopback `Host` headers
  (DNS-rebinding defence). CORS is an explicit allowlist, not `*`.
- Delete a conversation from the UI (confirmation required) or delete the `data/`
  folder to remove everything.

---

## Scientific rules the assistant follows

1. Never invent a measurement; say when evidence is missing.
2. A hotspot is a thermal anomaly, **not** a confirmed wildfire.
3. Active-fire detections are **not** burned area.
4. MODIS and VIIRS are different instruments; counts are not directly comparable.
5. Missing coverage is **unknown**, never zero.
6. No invented sensor conversion factors; HFAI indicators stay labelled experimental.
7. No fire prediction or emergency advice; no NASA endorsement.

The public FIREWATCH website's deterministic Evidence Engine remains the numerical
source of truth. Paste its evidence block into the "Attach evidence" field and the
assistant will quote those numbers rather than compute new ones.

---

## Files

```
install.bat / start.bat / tests.bat       Windows entry points
install.sh / start.sh                     macOS / Linux entry points
firewatch_ai/persona.py                   versioned system instructions
firewatch_ai/knowledge.py                 FTS5 index + retrieval + citations
firewatch_ai/store.py                     conversations + memory (SQLite)
firewatch_ai/runtime.py                   Ollama client + hardware suggestion
firewatch_ai/server.py                    loopback HTTP server + SSE chat API
firewatch_ai/selfcheck.py                 first-run diagnostic
web/index.html                            branded chat interface
knowledge/*.md                            curated scientific documents
tests/test_local.py                       offline unit tests
```

Run the tests with `tests.bat` or `python -m unittest discover -s tests -v`.

---

## Attribution

Active-fire product knowledge summarises NASA FIRMS / MODIS / VIIRS documentation
and the peer-reviewed literature (Giglio et al. 2016; Schroeder et al. 2014;
Wooster et al. 2003). FIREWATCH AI is an independent LH STUDIOS project, not
affiliated with or endorsed by NASA. Reviewed documents are LH STUDIOS original
text and are redistributable with this package.
