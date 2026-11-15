"""Launch the FIREWATCH AI engine."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import uvicorn  # noqa: E402

if __name__ == "__main__":
    uvicorn.run(
        "engine.app.main:app",
        host=os.environ.get("ENGINE_HOST", "127.0.0.1"),
        port=int(os.environ.get("ENGINE_PORT", "8010")),
        reload=False,
        log_level="info",
    )
