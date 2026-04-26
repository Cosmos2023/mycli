from __future__ import annotations

import os

import certifi

from mycli.infrastructure.ssl import ensure_certifi_ca_bundle


def test_ensure_certifi_ca_bundle_sets_env_when_missing(monkeypatch) -> None:
    monkeypatch.delenv("SSL_CERT_FILE", raising=False)

    ensure_certifi_ca_bundle()

    assert os.environ["SSL_CERT_FILE"] == certifi.where()


def test_ensure_certifi_ca_bundle_preserves_existing_env(monkeypatch) -> None:
    monkeypatch.setenv("SSL_CERT_FILE", "/tmp/custom.pem")

    ensure_certifi_ca_bundle()

    assert os.environ["SSL_CERT_FILE"] == "/tmp/custom.pem"
