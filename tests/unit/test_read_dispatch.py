from mycli.tools.read import read_file


class TestReadDispatch:
    def test_dispatches_text(self, tmp_path):
        f = tmp_path / "test.py"
        f.write_text("hello world\n")

        result = read_file(str(f))

        assert "error" not in result

    def test_dispatches_csv(self, tmp_path):
        f = tmp_path / "data.csv"
        f.write_text("a,b\n1,2\n")

        result = read_file(str(f))

        assert result["rows"] == 1

    def test_unknown_binary(self, tmp_path):
        f = tmp_path / "test.bin"
        f.write_bytes(b"\x00\x01\x02\xff\xfe\xfd")

        result = read_file(str(f))

        assert "error" in result
        assert "Cannot read binary file" in result["error"]

    def test_pdf_pages_param(self, tmp_path):
        result = read_file(str(tmp_path / "doc.pdf"), pages="1-5")

        assert result is not None
