from __future__ import annotations

from collections.abc import Callable, Iterable
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from hashlib import sha256
from threading import Lock
from uuid import uuid4

from mycli.domain.runtime import (
    QueueCapacity,
    QueueDisposition,
    QueueSnapshot,
    QueuedInputRecord,
)
from mycli.services.session_service import SessionService


@dataclass(slots=True, frozen=True)
class QueueMutationResult:
    disposition: QueueDisposition
    record: QueuedInputRecord
    snapshot: QueueSnapshot


class QueueConflictError(ValueError):
    pass


class QueueCapacityError(ValueError):
    pass


@dataclass(slots=True, frozen=True)
class LegacyQueueMigration:
    token: str
    records: tuple[QueuedInputRecord, ...]


QueueListener = Callable[[QueueSnapshot], None]
DiagnosticCallback = Callable[[str, dict[str, object]], None]


class SessionQueueCoordinator:
    def __init__(
        self,
        *,
        session_id: str,
        session_service: SessionService,
        capacity: QueueCapacity = QueueCapacity(),
        id_factory: Callable[[], str] | None = None,
        now_factory: Callable[[], datetime] | None = None,
        diagnostic_callback: DiagnosticCallback | None = None,
    ) -> None:
        self._session_id = session_id
        self._session_service = session_service
        self._capacity = capacity
        self._id_factory = id_factory or (lambda: f"queue_{uuid4().hex}")
        self._now_factory = now_factory or (lambda: datetime.now(UTC))
        self._diagnostic_callback = diagnostic_callback
        self._lock = Lock()
        self._listeners: set[QueueListener] = set()
        self._snapshot = session_service.load_queue_snapshot(session_id)
        self._validate_capacity(self._snapshot)

    @classmethod
    def restore(
        cls,
        *,
        session_id: str,
        session_service: SessionService,
        committed_queue_ids: set[str],
        active_turn_id: str | None,
        capacity: QueueCapacity = QueueCapacity(),
        diagnostic_callback: DiagnosticCallback | None = None,
    ) -> SessionQueueCoordinator:
        coordinator = cls(
            session_id=session_id,
            session_service=session_service,
            capacity=capacity,
            diagnostic_callback=diagnostic_callback,
        )
        with coordinator._lock:
            current = coordinator._snapshot
            pending: list[QueuedInputRecord] = []
            rejected = list(current.rejected_steers)
            changed = False
            for record in current.pending_steers:
                if record.queue_id in committed_queue_ids:
                    changed = True
                    continue
                if active_turn_id is None or record.target_turn_id != active_turn_id:
                    rejected.append(
                        record.transition(
                            kind="rejected_steer",
                            state="queued",
                            now=coordinator._now_factory(),
                        )
                    )
                    changed = True
                    continue
                pending.append(record)
            filtered_rejected = tuple(
                record
                for record in rejected
                if record.queue_id not in committed_queue_ids
            )
            filtered_follow_ups = tuple(
                record
                for record in current.follow_ups
                if record.queue_id not in committed_queue_ids
            )
            if len(filtered_rejected) != len(rejected) or len(filtered_follow_ups) != len(
                current.follow_ups
            ):
                changed = True
            if changed:
                candidate = replace(
                    current,
                    revision=current.revision + 1,
                    pending_steers=tuple(pending),
                    rejected_steers=filtered_rejected,
                    follow_ups=filtered_follow_ups,
                )
                coordinator._validate_capacity(candidate)
                coordinator._session_service.save_queue_snapshot(session_id, candidate)
                coordinator._snapshot = candidate
        return coordinator

    def snapshot(self) -> QueueSnapshot:
        with self._lock:
            return self._snapshot

    def subscribe(self, listener: QueueListener) -> Callable[[], None]:
        with self._lock:
            self._listeners.add(listener)

        def unsubscribe() -> None:
            with self._lock:
                self._listeners.discard(listener)

        return unsubscribe

    def enqueue_steer(
        self,
        *,
        text: str,
        client_turn_id: str,
        expected_turn_id: str,
        active_turn_id: str | None,
        steerable: bool,
        image_paths: tuple[str, ...] = (),
        source: str = "user",
    ) -> QueueMutationResult:
        with self._lock:
            existing = self._record_for_client_turn_id(client_turn_id)
            if existing is not None:
                return self._duplicate_or_conflict(
                    existing,
                    text=text,
                    image_paths=image_paths,
                    target_turn_id=expected_turn_id,
                    source=source,
                )
            accepted = (
                steerable
                and active_turn_id is not None
                and expected_turn_id == active_turn_id
            )
            record = QueuedInputRecord.create(
                queue_id=self._id_factory(),
                session_id=self._session_id,
                client_turn_id=client_turn_id,
                target_turn_id=expected_turn_id,
                kind="pending_steer" if accepted else "rejected_steer",
                text=text,
                image_paths=image_paths,
                source=source,
                now=self._now_factory(),
            )
            current = self._snapshot
            candidate = replace(
                current,
                revision=current.revision + 1,
                pending_steers=(
                    (*current.pending_steers, record)
                    if accepted
                    else current.pending_steers
                ),
                rejected_steers=(
                    current.rejected_steers
                    if accepted
                    else (*current.rejected_steers, record)
                ),
            )
            candidate = self._bounded_candidate(candidate, source=source)
            listeners = self._persist_and_publish_locked(candidate)
            disposition = (
                QueueDisposition.ACCEPTED_FOR_TURN
                if accepted
                else QueueDisposition.DEFERRED_TO_END_OF_TURN
            )
        self._notify(listeners, candidate)
        return QueueMutationResult(disposition, record, candidate)

    def enqueue_follow_up(
        self,
        *,
        text: str,
        client_turn_id: str,
        image_paths: tuple[str, ...] = (),
        source: str = "user",
    ) -> QueueMutationResult:
        with self._lock:
            existing = self._record_for_client_turn_id(client_turn_id)
            if existing is not None:
                return self._duplicate_or_conflict(
                    existing,
                    text=text,
                    image_paths=image_paths,
                    target_turn_id=None,
                    source=source,
                )
            record = QueuedInputRecord.create(
                queue_id=self._id_factory(),
                session_id=self._session_id,
                client_turn_id=client_turn_id,
                target_turn_id=None,
                kind="follow_up",
                text=text,
                image_paths=image_paths,
                source=source,
                now=self._now_factory(),
            )
            current = self._snapshot
            candidate = replace(
                current,
                revision=current.revision + 1,
                follow_ups=(*current.follow_ups, record),
            )
            candidate = self._bounded_candidate(candidate, source=source)
            listeners = self._persist_and_publish_locked(candidate)
        self._notify(listeners, candidate)
        return QueueMutationResult(QueueDisposition.QUEUED_FOLLOW_UP, record, candidate)

    def claim_pending_steers(self, turn_id: str) -> tuple[QueuedInputRecord, ...]:
        with self._lock:
            return tuple(
                record
                for record in self._snapshot.pending_steers
                if record.target_turn_id in {turn_id, "turn_pending"}
            )

    def commit(self, queue_ids: Iterable[str]) -> QueueSnapshot:
        requested = tuple(dict.fromkeys(queue_ids))
        if not requested:
            return self.snapshot()
        with self._lock:
            current = self._snapshot
            pending_by_id = {record.queue_id: record for record in current.pending_steers}
            invalid = [queue_id for queue_id in requested if queue_id not in pending_by_id]
            if invalid:
                raise QueueConflictError(f"queue ids are not pending: {', '.join(invalid)}")
            requested_set = set(requested)
            candidate = replace(
                current,
                revision=current.revision + 1,
                pending_steers=tuple(
                    record
                    for record in current.pending_steers
                    if record.queue_id not in requested_set
                ),
            )
            listeners = self._persist_and_publish_locked(candidate)
        self._notify(listeners, candidate)
        return candidate

    def reject_pending_for_turn(self, turn_id: str) -> QueueSnapshot:
        with self._lock:
            current = self._snapshot
            matching = tuple(
                record
                for record in current.pending_steers
                if record.target_turn_id == turn_id
            )
            if not matching:
                return current
            matching_ids = {record.queue_id for record in matching}
            rejected = tuple(
                record.transition(
                    kind="rejected_steer",
                    state="queued",
                    now=self._now_factory(),
                )
                for record in matching
            )
            candidate = replace(
                current,
                revision=current.revision + 1,
                pending_steers=tuple(
                    record
                    for record in current.pending_steers
                    if record.queue_id not in matching_ids
                ),
                rejected_steers=(*current.rejected_steers, *rejected),
            )
            listeners = self._persist_and_publish_locked(candidate)
        self._notify(listeners, candidate)
        return candidate

    def next_end_of_turn(self) -> QueuedInputRecord | None:
        with self._lock:
            if self._snapshot.rejected_steers:
                return self._snapshot.rejected_steers[0]
            if self._snapshot.follow_ups:
                return self._snapshot.follow_ups[0]
            return None

    def mark_started(self, queue_id: str) -> QueueSnapshot:
        with self._lock:
            current = self._snapshot
            next_record = (
                current.rejected_steers[0]
                if current.rejected_steers
                else (current.follow_ups[0] if current.follow_ups else None)
            )
            if next_record is None or next_record.queue_id != queue_id:
                raise QueueConflictError("queue id is not the next end-of-turn record")
            candidate = replace(
                current,
                revision=current.revision + 1,
                rejected_steers=(
                    current.rejected_steers[1:]
                    if next_record.kind == "rejected_steer"
                    else current.rejected_steers
                ),
                follow_ups=(
                    current.follow_ups[1:]
                    if next_record.kind == "follow_up"
                    else current.follow_ups
                ),
            )
            listeners = self._persist_and_publish_locked(candidate)
        self._notify(listeners, candidate)
        return candidate

    def pop_last_follow_up(self) -> QueuedInputRecord | None:
        with self._lock:
            current = self._snapshot
            if not current.follow_ups:
                return None
            record = current.follow_ups[-1]
            candidate = replace(
                current,
                revision=current.revision + 1,
                follow_ups=current.follow_ups[:-1],
            )
            listeners = self._persist_and_publish_locked(candidate)
        self._notify(listeners, candidate)
        return record

    def clear(self) -> tuple[QueuedInputRecord, ...]:
        with self._lock:
            current = self._snapshot
            records = current.active_records()
            if not records:
                return ()
            candidate = QueueSnapshot(
                session_id=self._session_id,
                revision=current.revision + 1,
            )
            listeners = self._persist_and_publish_locked(candidate)
        self._notify(listeners, candidate)
        return records

    def legacy_user_queue_migration(self) -> LegacyQueueMigration | None:
        with self._lock:
            records = tuple(
                record
                for record in self._snapshot.active_records()
                if record.source != "task_notification"
            )
            if not records:
                return None
            token = self._migration_token(self._snapshot.revision, records)
            return LegacyQueueMigration(token=token, records=records)

    def ack_legacy_user_queue_migration(self, token: str) -> None:
        normalized_token = token.strip()
        with self._lock:
            current = self._snapshot
            records = tuple(
                record
                for record in current.active_records()
                if record.source != "task_notification"
            )
            expected = self._migration_token(current.revision, records) if records else None
            if not normalized_token or normalized_token != expected:
                raise QueueConflictError("legacy queue migration token is stale")
            record_ids = {record.queue_id for record in records}
            candidate = replace(
                self._without_records(current, record_ids),
                revision=current.revision + 1,
            )
            listeners = self._persist_and_publish_locked(candidate)
        self._notify(listeners, candidate)

    def drain_legacy_task_notifications(self) -> tuple[QueuedInputRecord, ...]:
        with self._lock:
            current = self._snapshot
            records = tuple(
                record
                for record in current.active_records()
                if record.source == "task_notification"
            )
            if not records:
                return ()
            record_ids = {record.queue_id for record in records}
            candidate = replace(
                self._without_records(current, record_ids),
                revision=current.revision + 1,
            )
            listeners = self._persist_and_publish_locked(candidate)
        self._notify(listeners, candidate)
        return records

    @staticmethod
    def _migration_token(
        revision: int,
        records: tuple[QueuedInputRecord, ...],
    ) -> str:
        identity = "\n".join(
            f"{record.queue_id}\0{record.kind}\0{record.updated_at}" for record in records
        )
        return sha256(f"{revision}\n{identity}".encode()).hexdigest()

    def _record_for_client_turn_id(self, client_turn_id: str) -> QueuedInputRecord | None:
        normalized = client_turn_id.strip()
        return next(
            (
                record
                for record in self._snapshot.active_records()
                if record.client_turn_id == normalized
            ),
            None,
        )

    def _duplicate_or_conflict(
        self,
        existing: QueuedInputRecord,
        *,
        text: str,
        image_paths: tuple[str, ...],
        target_turn_id: str | None,
        source: str,
    ) -> QueueMutationResult:
        normalized_images = tuple(dict.fromkeys(path for path in image_paths if path))
        normalized_target = target_turn_id.strip() if target_turn_id is not None else None
        if (
            existing.text == text.strip()
            and existing.image_paths == normalized_images
            and existing.target_turn_id == normalized_target
            and existing.source == source.strip()
        ):
            return QueueMutationResult(
                QueueDisposition.DUPLICATE,
                existing,
                self._snapshot,
            )
        raise QueueConflictError("client_turn_id is already used by different queued input")

    def _bounded_candidate(
        self,
        candidate: QueueSnapshot,
        *,
        source: str,
    ) -> QueueSnapshot:
        try:
            self._validate_capacity(candidate)
            return candidate
        except QueueCapacityError:
            if source != "task_notification":
                raise
        oldest_internal = next(
            (
                record
                for record in candidate.active_records()
                if record.source == "task_notification"
                and record.client_turn_id != candidate.active_records()[-1].client_turn_id
            ),
            None,
        )
        if oldest_internal is None:
            self._emit_capacity_diagnostic(candidate)
            raise QueueCapacityError("queue capacity exceeded")
        candidate = self._without_records(candidate, {oldest_internal.queue_id})
        try:
            self._validate_capacity(candidate)
        except QueueCapacityError:
            self._emit_capacity_diagnostic(candidate)
            raise
        return candidate

    def _validate_capacity(self, snapshot: QueueSnapshot) -> None:
        records = snapshot.active_records()
        if len(records) > self._capacity.max_records:
            raise QueueCapacityError("queue record limit exceeded")
        if any(len(record.text.encode("utf-8")) > self._capacity.max_text_bytes for record in records):
            raise QueueCapacityError("queue record text limit exceeded")
        if sum(len(record.text.encode("utf-8")) for record in records) > self._capacity.max_total_text_bytes:
            raise QueueCapacityError("queue aggregate text limit exceeded")
        if any(len(record.image_paths) > self._capacity.max_attachments for record in records):
            raise QueueCapacityError("queue attachment limit exceeded")

    def _persist_and_publish_locked(
        self,
        candidate: QueueSnapshot,
    ) -> tuple[QueueListener, ...]:
        self._validate_capacity(candidate)
        self._session_service.save_queue_snapshot(self._session_id, candidate)
        self._snapshot = candidate
        return tuple(self._listeners)

    def _without_records(
        self,
        snapshot: QueueSnapshot,
        record_ids: set[str],
    ) -> QueueSnapshot:
        return replace(
            snapshot,
            pending_steers=tuple(
                record for record in snapshot.pending_steers if record.queue_id not in record_ids
            ),
            rejected_steers=tuple(
                record for record in snapshot.rejected_steers if record.queue_id not in record_ids
            ),
            follow_ups=tuple(
                record for record in snapshot.follow_ups if record.queue_id not in record_ids
            ),
        )

    def _emit_capacity_diagnostic(self, snapshot: QueueSnapshot) -> None:
        if self._diagnostic_callback is not None:
            self._diagnostic_callback(
                "queue.capacity_exceeded",
                {"session_id": self._session_id, "revision": snapshot.revision},
            )

    @staticmethod
    def _notify(
        listeners: tuple[QueueListener, ...],
        snapshot: QueueSnapshot,
    ) -> None:
        for listener in listeners:
            try:
                listener(snapshot)
            except Exception:
                continue


__all__ = [
    "LegacyQueueMigration",
    "QueueCapacityError",
    "QueueConflictError",
    "QueueMutationResult",
    "SessionQueueCoordinator",
]
