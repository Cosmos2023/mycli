from __future__ import annotations

SUPPORTED_GATEWAY_RPC_METHODS = frozenset(
    {
        "approval.respond",
        "clarify.respond",
        "command.run",
        "completion.path",
        "completion.slash",
        "decision.resolve",
        "extension.manifest",
        "session.bootstrap",
        "session.list",
        "session.resume",
        "shutdown",
        "status.inspect",
        "trace.export",
        "transcript.load",
        "turn.interrupt",
        "turn.submit",
    }
)

SUPPORTED_GATEWAY_EVENT_STREAMS = frozenset(
    {
        "approval.request",
        "approval.respond",
        "clarify.request",
        "clarify.respond",
        "gateway.error",
        "message.complete",
        "message.delta",
        "reasoning.delta",
        "runtime.event",
        "session.changed",
        "status.changed",
        "status.update",
        "thinking.delta",
        "tool.complete",
        "tool.failed",
        "tool.progress",
        "tool.start",
        "turn.completed",
        "turn.event",
        "turn.failed",
        "turn.interrupted",
        "turn.started",
        "turn.status",
    }
)
