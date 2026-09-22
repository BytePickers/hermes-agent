"""``profiles.list`` results validate against the declared contract.

Wire-drift regression: the serializer has surfaced ``previous_names`` since #110200, but
``ProfileRow`` never declared the field, so every roster poll on a fleet-sized host logged a
55-error contract violation (``profiles.N.previous_names: Extra inputs are not permitted``).
The runtime check is log-only outside the test suite, so only a handler-level test catches it.
"""
from __future__ import annotations

import pytest

import tui_gateway.server as srv
from tui_gateway.contracts import registry
from tui_gateway.contracts.profiles_vault_complete_foreign_subagents import ProfilesListResult


@pytest.fixture
def home(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    for name in ("bob", "alice"):
        (tmp_path / "profiles" / name).mkdir(parents=True)
        (tmp_path / "profiles" / name / "config.yaml").write_text(
            "model:\n  provider: openai\n", encoding="utf-8"
        )
    return tmp_path


def _result(params=None) -> dict:
    return srv._methods["profiles.list"](1, params or {})["result"]


def test_result_validates_against_the_declared_contract(home):
    from hermes_cli.profiles import write_profile_meta

    write_profile_meta(home / "profiles" / "bob", previous_names=["oldbob", "older-bob"])

    result = _result()
    contract = registry.METHODS["profiles.list"]
    # The exact check the live gateway runs on every response (raises under the suite).
    registry.check_result(contract, result)
    # Belt and braces: validate the declared model directly, independent of the STRICT
    # environment (``contract.result`` is statically just ``type[Result]``).
    assert contract.result is ProfilesListResult
    rows = {row.name: row for row in ProfilesListResult.model_validate(result).profiles}
    assert rows["bob"].previous_names == ["oldbob", "older-bob"]
    assert rows["alice"].previous_names == []
