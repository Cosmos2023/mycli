from mycli.tools.web_search import _normalize_serpapi_results, web_search


class TestWebSearch:
    def test_deepseek_returns_tool_definition(self):
        result = web_search("latest Python version", provider="deepseek")

        assert "_tool_definition" in result
        assert result["_tool_definition"]["type"] == "web_search_20250305"

    def test_serpapi_fallback(self, monkeypatch):
        def mock_call_serpapi(query):
            assert query == "Python version"
            return {
                "organic_results": [
                    {"title": "Python 3.14", "link": "https://python.org"},
                    {"title": "Downloads", "link": "https://python.org/downloads"},
                ]
            }

        monkeypatch.setattr("mycli.tools.web_search._call_serpapi", mock_call_serpapi)

        result = web_search("Python version", provider="serpapi")

        assert len(result["results"]) == 2
        assert result["results"][0]["title"] == "Python 3.14"
        assert "url" in result["results"][0]

    def test_normalize_serpapi_results(self):
        result = _normalize_serpapi_results(
            {"organic_results": [{"title": "A", "link": "https://example.com"}]}
        )

        assert result == {
            "results": [{"title": "A", "url": "https://example.com"}],
            "total": 1,
        }
