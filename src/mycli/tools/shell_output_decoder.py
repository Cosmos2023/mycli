from __future__ import annotations

import codecs
from dataclasses import dataclass
from typing import Literal

from mycli.tools.shell_transport import ShellStream


_EscapeState = Literal["text", "escape", "csi", "osc", "osc_escape"]


@dataclass(slots=True)
class _TerminalSanitizer:
    escape_state: _EscapeState = "text"
    pending_carriage_return: bool = False

    def feed(self, text: str) -> str:
        output: list[str] = []
        for character in text:
            self._consume(character, output)
        return "".join(output)

    def flush(self) -> str:
        output = "\n" if self.pending_carriage_return else ""
        self.pending_carriage_return = False
        self.escape_state = "text"
        return output

    def _consume(self, character: str, output: list[str]) -> None:
        if self.escape_state == "escape":
            if character == "[":
                self.escape_state = "csi"
            elif character == "]":
                self.escape_state = "osc"
            elif character != "\x1b":
                self.escape_state = "text"
            return
        if self.escape_state == "csi":
            if "@" <= character <= "~":
                self.escape_state = "text"
            return
        if self.escape_state == "osc":
            if character == "\x07":
                self.escape_state = "text"
            elif character == "\x1b":
                self.escape_state = "osc_escape"
            return
        if self.escape_state == "osc_escape":
            self.escape_state = "text" if character == "\\" else "osc"
            return

        if self.pending_carriage_return:
            output.append("\n")
            self.pending_carriage_return = False
            if character == "\n":
                return

        if character == "\x1b":
            self.escape_state = "escape"
            return
        if character == "\r":
            self.pending_carriage_return = True
            return
        if character == "\b":
            if output and output[-1] not in {"\n", "\t"}:
                output.pop()
            return
        if ord(character) < 32 and character not in {"\n", "\t"}:
            return
        output.append(character)


@dataclass(slots=True)
class _StreamState:
    decoder: codecs.IncrementalDecoder
    sanitizer: _TerminalSanitizer
    flushed: bool = False


class ShellOutputDecoder:
    def __init__(self, *, encoding: str = "utf-8") -> None:
        decoder_factory = codecs.getincrementaldecoder(encoding)
        streams: tuple[ShellStream, ...] = ("stdout", "stderr", "terminal")
        self._states: dict[ShellStream, _StreamState] = {
            stream: _StreamState(
                decoder=decoder_factory(errors="replace"),
                sanitizer=_TerminalSanitizer(),
            )
            for stream in streams
        }
        self._replacement_count = 0

    @property
    def replacement_count(self) -> int:
        return self._replacement_count

    def feed(self, stream: ShellStream, data: bytes) -> str:
        state = self._states[stream]
        if state.flushed:
            raise ValueError(f"Shell output stream already flushed: {stream}")
        decoded = state.decoder.decode(data, final=False)
        self._replacement_count += decoded.count("\ufffd")
        return state.sanitizer.feed(decoded)

    def flush(self, stream: ShellStream) -> str:
        state = self._states[stream]
        if state.flushed:
            return ""
        state.flushed = True
        decoded = state.decoder.decode(b"", final=True)
        self._replacement_count += decoded.count("\ufffd")
        return state.sanitizer.feed(decoded) + state.sanitizer.flush()


__all__ = ["ShellOutputDecoder"]
