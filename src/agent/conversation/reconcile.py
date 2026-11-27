"""Retry pending conversation persistence from the command line (cron, ops, or after an outage).

    PYTHONPATH=src python -m agent.conversation.reconcile          # one pass
    PYTHONPATH=src python -m agent.conversation.reconcile --loop   # keep running

Reads REDIS_URL and DATABASE_URL from the environment / .env.
"""
from __future__ import annotations

import argparse
import asyncio
import logging
from pathlib import Path

from dotenv import load_dotenv

from .buffer import ConversationBuffer
from .persistence import ConversationPersistenceService
from .store import PostgresConversationStore


async def main(loop_forever: bool, interval: float) -> None:
    buffer = ConversationBuffer.from_env()
    store = PostgresConversationStore.from_env()
    if store is None:
        raise SystemExit("DATABASE_URL is not set; nothing can be persisted.")
    service = ConversationPersistenceService.from_env(buffer, store)
    try:
        if loop_forever:
            await service.run_forever(interval)
        else:
            print(await service.reconcile_once())
    finally:
        await store.close()


if __name__ == "__main__":
    load_dotenv(Path(__file__).resolve().parents[3] / ".env")
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--loop", action="store_true", help="run continuously")
    parser.add_argument("--interval", type=float, default=60.0, help="seconds between passes with --loop")
    args = parser.parse_args()
    asyncio.run(main(args.loop, args.interval))
