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
        assert "content" in result
        assert "name,age,city" in result["content"]
        assert "Alice,30,NYC" in result["content"]
        assert result["shown_lines"] == 4

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
        assert "content" in result
        assert "id,value" in result["content"]
        assert result["shown_lines"] == 21

    def test_csv_offset_limit_returns_targeted_rows(self, tmp_path):
        f = tmp_path / "data.csv"
        f.write_text("name,age\nAlice,30\nBob,25\nCharlie,35\nDana,28\n")

        result = read_csv_handler(str(f), offset=3, limit=2)

        assert result["rows"] == 4
        assert result["shown_lines"] == 2
        assert result["truncated"] is True
        assert "Bob,25" in result["content"]
        assert "Charlie,35" in result["content"]
        assert "Alice,30" not in result["content"]

    def test_tsv(self, tmp_path):
        f = tmp_path / "data.tsv"
        f.write_text("a\tb\tc\n1\t2\t3\n")

        result = read_csv_handler(str(f))

        assert result["columns"] == 3
        assert "a\tb\tc" in result["content"]
        assert "1\t2\t3" in result["content"]

    def test_csv_content_includes_numeric_profile(self, tmp_path):
        f = tmp_path / "weekly_sales.csv"
        f.write_text(
            "owner,region,weekly_revenue,new_deals\n"
            "Lin,East,128000,5\n"
            "Chen,South,42000,2\n"
            "Ho,West,131000,5\n"
        )

        result = read_csv_handler(str(f))

        assert result["numeric_summary"]["weekly_revenue"]["sum"] == 301000
        assert "Data profile:" in result["content"]
        assert "weekly_revenue: sum=301000" in result["content"]
        assert "min=42000" in result["content"]
        assert "owner=Chen" in result["content"]
