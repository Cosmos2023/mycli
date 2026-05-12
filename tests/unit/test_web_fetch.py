import time

from mycli.tools.web_fetch import _html_to_markdown, web_fetch


class TestWebFetch:
    def test_html_to_markdown(self):
        html = "<h1>Title</h1><p>Hello <b>world</b></p>"

        md = _html_to_markdown(html)

        assert "Title" in md
        assert "Hello" in md
        assert "world" in md

    def test_url_normalization(self):
        from mycli.tools.web_fetch import _normalize_url

        assert _normalize_url("http://example.com") == "https://example.com"
        assert _normalize_url("https://user:pass@example.com") == "https://example.com"

    def test_cache_hit(self):
        from mycli.tools.web_fetch import _fetch_cache, _get_cached

        _fetch_cache.clear()
        _fetch_cache["test_key"] = {"ts": time.time(), "data": {"cached": True}}

        result = _get_cached("test_key")

        assert result is not None
        assert result["cached"] is True

    def test_cache_expiry(self):
        from mycli.tools.web_fetch import _fetch_cache, _get_cached

        _fetch_cache.clear()
        _fetch_cache["old_key"] = {"ts": time.time() - 1000, "data": {"old": True}}

        assert _get_cached("old_key") is None

    def test_web_fetch_uses_cache(self, monkeypatch):
        from mycli.tools.web_fetch import _fetch_cache

        _fetch_cache.clear()

        class Response:
            status_code = 200
            text = "<h1>Cached</h1>"

        calls = []

        def mock_get(url, **kwargs):
            calls.append((url, kwargs))
            return Response()

        monkeypatch.setattr("requests.get", mock_get)

        first = web_fetch("http://example.com")
        second = web_fetch("http://example.com")

        assert first == second
        assert len(calls) == 1
