from mycli.tools.read.text import read_text


class TestReadText:
    def test_full_read(self, tmp_path):
        f = tmp_path / "test.py"
        f.write_text("line1\nline2\nline3\n")
        result = read_text(str(f))
        assert result["content"] == "     1\tline1\n     2\tline2\n     3\tline3\n"
        assert result["truncated"] is False

    def test_offset_and_limit(self, tmp_path):
        f = tmp_path / "test.py"
        f.write_text("\n".join(f"line{i}" for i in range(1, 21)))
        result = read_text(str(f), offset=5, limit=3)
        lines = result["content"].strip().split("\n")
        assert len(lines) == 3
        assert "line5" in lines[0]

    def test_truncated_flag(self, tmp_path):
        f = tmp_path / "test.py"
        f.write_text("\n".join(f"line{i}" for i in range(1, 3001)))
        result = read_text(str(f))
        assert result["truncated"] is True
        assert "output truncated" in result["content"]

    def test_line_truncation(self, tmp_path):
        f = tmp_path / "test.py"
        f.write_text("a" * 3000 + "\n")
        result = read_text(str(f))
        assert "[... truncated]" in result["content"]

    def test_file_not_found(self):
        result = read_text("/nonexistent/path.py")
        assert "File not found" in result["error"]

    def test_directory(self, tmp_path):
        result = read_text(str(tmp_path))
        assert "Path is a directory" in result["error"]

    def test_default_limit(self, tmp_path):
        f = tmp_path / "large.py"
        f.write_text("\n".join(f"line{i}" for i in range(1, 2501)))
        result = read_text(str(f))
        assert result["total_lines"] == 2500
        assert result["shown_lines"] == 2000

    def test_file_too_large_by_token_count(self, tmp_path):
        f = tmp_path / "huge.py"
        f.write_text(" ".join(str(i) for i in range(30_000)))
        result = read_text(str(f))
        assert "error" in result
        assert "too large" in result["error"].lower()
        assert "tokens" in result["error"].lower()

    def test_reads_long_low_token_file_without_head_tail_truncation(self, tmp_path):
        f = tmp_path / "medium.py"
        content = "a" * 120_000
        f.write_text(content)

        result = read_text(str(f))

        assert result["truncated"] is False
        assert "... [chars omitted] ..." not in result["content"]
        assert "a" * 100 in result["content"]
        assert result["total_tokens"] <= 25_000
