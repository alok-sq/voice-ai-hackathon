"""Conversation persistence: live call -> Redis buffer -> call ends -> PostgreSQL conversation log.

Nothing in this package imports LiveKit, so it is unit testable on its own.

    ConversationRecorder        one per call; listens to EventPublisher events
    ConversationBuffer          Redis staging store (ordered, idempotent, no TTL until persisted)
    ConversationStore           permanent store (PostgresConversationStore in production)
    ConversationPersistenceService  Redis -> PostgreSQL, with locking, retry and reconciliation
    build_record / build_text_log   the final conversation record and readable log
"""
from .buffer import ConversationBuffer
from .log_builder import build_record, build_text_log
from .models import ConversationMeta, ConversationStatus, Message
from .persistence import ConversationPersistenceService
from .recorder import ConversationRecorder
from .store import ConversationStore, PostgresConversationStore

__all__ = [
    "ConversationBuffer",
    "ConversationMeta",
    "ConversationPersistenceService",
    "ConversationRecorder",
    "ConversationStatus",
    "ConversationStore",
    "Message",
    "PostgresConversationStore",
    "build_record",
    "build_text_log",
]
