"""Offline tests for FIREWATCH AI Local Edition. No network, no model required."""
from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BASE))

from firewatch_ai import FINETUNED, VERSION  # noqa: E402
from firewatch_ai.knowledge import KnowledgeBase, citations  # noqa: E402
from firewatch_ai.persona import PERSONA_VERSION, SYSTEM_PROMPT, build_system_prompt  # noqa: E402
from firewatch_ai.runtime import PROFILES, hardware  # noqa: E402
from firewatch_ai.store import Store  # noqa: E402


class KnowledgeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.tmp = tempfile.TemporaryDirectory()
        cls.kb = KnowledgeBase(Path(cls.tmp.name) / "kb.db", BASE / "knowledge")
        cls.stats = cls.kb.ensure()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.tmp.cleanup()

    def test_documents_are_indexed(self) -> None:
        self.assertGreaterEqual(self.stats["documents"], 6)
        self.assertGreater(self.stats["chunks"], 10)
        self.assertEqual(self.kb.stats()["chunks"], self.stats["chunks"])

    def test_reindex_is_idempotent(self) -> None:
        again = self.kb.ensure()
        self.assertEqual(again["chunks"], self.stats["chunks"])

    def test_retrieval_returns_relevant_chunk(self) -> None:
        hits = self.kb.search("fire radiative power megawatts", k=3)
        self.assertTrue(hits)
        joined = " ".join(h.text.lower() for h in hits)
        self.assertIn("frp", joined)

    def test_retrieval_is_deterministic(self) -> None:
        a = [h.sha256 for h in self.kb.search("MODiS VIIRS footprint", k=4)]
        b = [h.sha256 for h in self.kb.search("MODiS VIIRS footprint", k=4)]
        self.assertEqual(a, b)

    def test_citation_labels(self) -> None:
        cites = citations(self.kb.search("coverage unknown zero", k=2))
        self.assertEqual(cites[0]["label"], "K1")
        self.assertIn("title", cites[0])

    def test_unknown_topic_is_empty_not_invented(self) -> None:
        self.assertEqual(self.kb.search("zzzqqq", k=3), [])


class PersonaTests(unittest.TestCase):
    def test_identity_and_version(self) -> None:
        self.assertIn("FIREWATCH AI", SYSTEM_PROMPT)
        self.assertIn("LH STUDIOS", SYSTEM_PROMPT)
        self.assertTrue(PERSONA_VERSION.startswith("firewatch-persona"))
        self.assertFalse(FINETUNED)

    def test_grounding_rules(self) -> None:
        for phrase in [
            "Never invent a measurement",
            "not a confirmed wildfire",
            "Missing observations are not zero",
            "No fire prediction",
            "Do not claim NASA endorsement",
        ]:
            self.assertIn(phrase, SYSTEM_PROMPT)

    def test_memory_is_labelled_as_user_statement(self) -> None:
        prompt = build_system_prompt(["prefers metric units"])
        self.assertIn("prefers metric units", prompt)
        self.assertIn("not scientific evidence", prompt)


class StoreTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.store = Store(Path(self.tmp.name) / "chat.db")
        self.store.ensure()

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_conversation_lifecycle(self) -> None:
        convo = self.store.create_conversation("Nepal burning")
        self.assertEqual(len(self.store.list_conversations()), 1)
        self.store.add_message(convo["id"], "user", "What is FRP?")
        self.store.add_message(convo["id"], "assistant", "Fire radiative power…")
        got = self.store.get_conversation(convo["id"])
        self.assertIsNotNone(got)
        self.assertEqual([m["role"] for m in got["messages"]], ["user", "assistant"])
        self.assertTrue(self.store.delete_conversation(convo["id"]))
        self.assertIsNone(self.store.get_conversation(convo["id"]))

    def test_delete_removes_messages(self) -> None:
        convo = self.store.create_conversation("temp")
        self.store.add_message(convo["id"], "user", "hello")
        self.store.delete_conversation(convo["id"])
        self.assertEqual(self.store.history(convo["id"]), [])

    def test_memory_roundtrip(self) -> None:
        self.store.remember("calls the Amazon Basin 'the basin'")
        self.assertIn("the basin", self.store.memories()[0])

    def test_history_count_and_order(self) -> None:
        convo = self.store.create_conversation("h")
        for i in range(20):
            self.store.add_message(convo["id"], "user", f"m{i}")
        history = self.store.history(convo["id"], limit=5)
        self.assertEqual(len(history), 5)
        self.assertEqual(history[-1]["content"], "m19")


class RuntimeTests(unittest.TestCase):
    def test_profiles_are_honest_and_licensed(self) -> None:
        self.assertEqual(set(PROFILES), {"A", "B", "C"})
        for profile in PROFILES.values():
            self.assertTrue(profile.licence)
            self.assertIn("GB", profile.approx_vram)

    def test_hardware_recommendation_is_labelled_as_advice(self) -> None:
        hw = hardware()
        self.assertIn(hw["recommendedProfile"], {"A", "B", "C"})
        self.assertIn("not a benchmark", hw["caveat"])
        self.assertIn("decided by the local Ollama runtime", hw["gpu"])

    def test_version(self) -> None:
        self.assertEqual(VERSION, "0.2.0")


if __name__ == "__main__":
    unittest.main(verbosity=2)
