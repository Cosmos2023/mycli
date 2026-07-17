from mycli.tools.shell_output_decoder import ShellOutputDecoder


def test_decoder_preserves_utf8_split_across_chunks() -> None:
    decoder = ShellOutputDecoder()
    encoded = "你好".encode()

    first = decoder.feed("stdout", encoded[:2])
    second = decoder.feed("stdout", encoded[2:])

    assert first + second == "你好"
    assert "�" not in first + second


def test_decoder_normalizes_terminal_controls() -> None:
    decoder = ShellOutputDecoder()

    text = decoder.feed(
        "terminal",
        b"\x1b[31mred\x1b[0m\rnext\x1b]0;title\x07\n",
    )

    assert text == "red\nnext\n"
    assert "\x1b" not in text


def test_decoder_strips_escape_sequences_split_across_chunks() -> None:
    decoder = ShellOutputDecoder()

    first = decoder.feed("terminal", b"before\x1b[3")
    second = decoder.feed("terminal", b"1mred\x1b]0;ti")
    third = decoder.feed("terminal", b"tle\x1b\\after")

    assert first + second + third == "beforeredafter"


def test_decoder_processes_backspace_within_chunk() -> None:
    decoder = ShellOutputDecoder()

    assert decoder.feed("terminal", b"abc\bX") == "abX"


def test_decoder_flushes_incomplete_invalid_bytes_once() -> None:
    decoder = ShellOutputDecoder()

    assert decoder.feed("stdout", b"\xe4") == ""
    assert decoder.flush("stdout") == "�"
    assert decoder.flush("stdout") == ""
    assert decoder.replacement_count == 1
