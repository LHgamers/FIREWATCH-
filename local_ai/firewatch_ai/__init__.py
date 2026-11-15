"""FIREWATCH AI — Local Scientific Intelligence by LH STUDIOS.

A local, offline-capable scientific assistant for satellite active-fire
observations. This package contains no model weights: inference is performed by
a locally installed Ollama runtime, on the user's own machine.

Layer labelling (keep this honest in every release):
  · base model          pretrained weights pulled from the Ollama registry
  · system instructions persona.py (hand-written, versioned)
  · knowledge + RAG     knowledge.py (SQLite FTS5 over the shipped documents)
  · fine-tuning         none — see persona.FINETUNED
"""

VERSION = "0.2.0"
PRODUCT = "FIREWATCH AI"
TAGLINE = "Local Scientific Intelligence by LH STUDIOS"
FINETUNED = False
"""
Whether the weights were trained by LH STUDIOS. They were not. Prompting and
retrieval are not training, and this constant exists so no layer of the product
can claim otherwise by accident.
"""

__all__ = ["VERSION", "PRODUCT", "TAGLINE", "FINETUNED"]
