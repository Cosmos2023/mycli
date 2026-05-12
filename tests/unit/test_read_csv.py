from mycli.tools.read.csv_handler import read_file as read_csv_handler


class TestReadCSV:
    def test_small_csv(self, tmp_path):
        f = tmp_path / "data.csv"
        f.write_text("name,age,city\nAlice,30,NYC\nBob,25,SF\nCharlie,35,LA\n")

        result = read_csv_handler(str(f))

        assert result["rows"] == 3
        assert result["columns"] == 3
        assert result["headers"] == ["name", "age", "city"]
        assert len(result["preview"]) == 3

    def test_large_csv_head_tail(self, tmp_path):
        f = tmp_path / "large.csv"
        lines = ["id,value"] + [f"{i},{i * 2}" for i in range(1, 101)]
        f.write_text("\n".join(lines))

        result = read_csv_handler(str(f))

        assert result["rows"] == 100
        assert result["truncated"] is True
        assert len(result["preview"]) == 20
        assert len(result["headers"]) == 2
        assert "tail_preview" in result
        assert len(result["tail_preview"]) == 10

    def test_tsv(self, tmp_path):
        f = tmp_path / "data.tsv"
        f.write_text("a\tb\tc\n1\t2\t3\n")

        result = read_csv_handler(str(f))

        assert result["columns"] == 3
