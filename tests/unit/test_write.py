from mycli.tools.write import write_file


class TestWrite:
    def test_create_new_file(self, tmp_path):
        f = tmp_path / "new.py"

        result = write_file(str(f), "print('hello')\n")

        assert f.exists()
        assert f.read_text() == "print('hello')\n"
        assert result["status"] == "created"

    def test_overwrite_existing(self, tmp_path):
        f = tmp_path / "test.py"
        f.write_text("old\n")

        result = write_file(str(f), "new\n")

        assert f.read_text() == "new\n"
        assert result["status"] == "overwritten"

    def test_autocreate_parent_dir(self, tmp_path):
        f = tmp_path / "deep" / "nested" / "file.py"

        write_file(str(f), "content\n")

        assert f.exists()

    def test_unchanged_noop(self, tmp_path):
        f = tmp_path / "test.py"
        f.write_text("same\n")

        result = write_file(str(f), "same\n")

        assert result["status"] == "unchanged"
