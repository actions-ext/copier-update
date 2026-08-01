from __future__ import annotations

import subprocess
from datetime import UTC, datetime
from pathlib import Path

import pytest

from copier_update_app.github import Installation, Repository
from copier_update_app.updater import Updater


class FakeClient:
    def __init__(self, repositories: list[Repository]) -> None:
        self._repositories = repositories
        self.answers = {repository.full_name: ".copier-answers.yaml" for repository in repositories}
        self.open_updates: set[str] = set()
        self.pull_requests: list[tuple[str, str, str]] = []
        self.token_requests: list[tuple[int, int | None]] = []

    def installations(self) -> list[Installation]:
        return [Installation(id=10, account_login="owner", account_type="Organization")]

    def installation_token(self, installation_id: int, repository_id: int | None = None) -> str:
        self.token_requests.append((installation_id, repository_id))
        return "installation-token" if repository_id is None else f"repository-token-{repository_id}"

    def repositories(self, token: str) -> list[Repository]:
        assert token == "installation-token"
        return self._repositories

    def copier_answers_file(self, repository: Repository, token: str) -> str | None:
        return self.answers.get(repository.full_name)

    def has_open_update(self, repository: Repository, token: str, branch_prefix: str) -> bool:
        return repository.full_name in self.open_updates

    def create_pull_request(self, repository: Repository, token: str, branch: str, title: str) -> str:
        self.pull_requests.append((repository.full_name, branch, title))
        return f"https://github.com/{repository.full_name}/pull/1"


class RecordingUpdater(Updater):
    def __init__(self, client: FakeClient, failures: set[str] | None = None, **kwargs) -> None:
        super().__init__(client, **kwargs)
        self.failures = failures or set()
        self.updated: list[tuple[str, str, str]] = []

    def update_repository(self, repository: Repository, answers_file: str, token: str) -> bool:
        if repository.full_name in self.failures:
            raise RuntimeError("update failed")
        self.updated.append((repository.full_name, answers_file, token))
        return True


class CommandRecordingUpdater(Updater):
    def __init__(self, client: FakeClient, *, status: str) -> None:
        super().__init__(client, now=lambda: datetime(2026, 8, 1, 12, 34, 56, tzinfo=UTC))
        self.commands: list[tuple[list[str], str | None]] = []
        self.status = status

    def _run(self, command, *, cwd=None, token=None, capture_output=False):
        command = list(command)
        self.commands.append((command, token))
        if command[:2] == ["git", "clone"]:
            Path(command[-1]).mkdir()
        stdout = self.status if command[:3] == ["git", "status", "--porcelain"] else ""
        return subprocess.CompletedProcess(command, 0, stdout=stdout, stderr="")


def test_updates_eligible_repository_with_restricted_token():
    repository = Repository(id=20, full_name="owner/repository", default_branch="main")
    client = FakeClient([repository])
    updater = RecordingUpdater(client)

    summary = updater.run()

    assert (summary.checked, summary.updated, summary.skipped, summary.failed) == (1, 1, 0, 0)
    assert updater.updated == [("owner/repository", ".copier-answers.yaml", "repository-token-20")]
    assert client.token_requests == [(10, None), (10, 20)]


def test_skips_inactive_unmanaged_and_open_repositories():
    archived = Repository(id=1, full_name="owner/archived", default_branch="main", archived=True)
    unmanaged = Repository(id=2, full_name="owner/unmanaged", default_branch="main")
    open_update = Repository(id=3, full_name="owner/open", default_branch="main")
    client = FakeClient([archived, unmanaged, open_update])
    client.answers.pop(unmanaged.full_name)
    client.open_updates.add(open_update.full_name)
    updater = RecordingUpdater(client)

    summary = updater.run()

    assert (summary.checked, summary.updated, summary.skipped, summary.failed) == (3, 0, 3, 0)
    assert updater.updated == []
    assert client.token_requests == [(10, None)]


def test_continues_after_repository_failure():
    first = Repository(id=1, full_name="owner/first", default_branch="main")
    second = Repository(id=2, full_name="owner/second", default_branch="main")
    updater = RecordingUpdater(FakeClient([first, second]), failures={first.full_name})

    summary = updater.run()

    assert (summary.checked, summary.updated, summary.skipped, summary.failed) == (2, 1, 0, 1)
    assert updater.updated[0][0] == second.full_name


def test_repository_filter_must_match_installation():
    updater = RecordingUpdater(FakeClient([]), repository_filter="owner/missing")

    with pytest.raises(RuntimeError, match="not available"):
        updater.run()


def test_filters_owner_visibility_and_selected_repositories():
    public = Repository(id=1, full_name="owner/public", default_branch="main")
    private = Repository(id=2, full_name="owner/private", default_branch="main", private=True)
    updater = RecordingUpdater(
        FakeClient([public, private]),
        owner_filter="OWNER",
        visibility_filter="private",
    )

    summary = updater.run()

    assert (summary.checked, summary.updated) == (1, 1)
    assert [repository for repository, _, _ in updater.updated] == ["owner/private"]


def test_selected_repositories_must_all_match_installation():
    repository = Repository(id=1, full_name="owner/available", default_branch="main")
    updater = RecordingUpdater(
        FakeClient([repository]),
        repository_filters={"owner/available", "owner/missing"},
    )

    with pytest.raises(RuntimeError, match="owner/missing"):
        updater.run()


def test_owner_filter_must_match_installation():
    updater = RecordingUpdater(FakeClient([]), owner_filter="missing")

    with pytest.raises(RuntimeError, match="Account 'missing' is not available"):
        updater.run()


def test_target_subprocess_does_not_inherit_app_private_key(monkeypatch):
    captured = {}

    def fake_run(command, **kwargs):
        captured["command"] = command
        captured["environment"] = kwargs["env"]
        return subprocess.CompletedProcess(command, 0, stdout="", stderr="")

    monkeypatch.setenv("COPIER_APP_ID", "123")
    monkeypatch.setenv("COPIER_APP_PRIVATE_KEY", "private")
    monkeypatch.setattr("copier_update_app.updater.subprocess.run", fake_run)
    updater = Updater(FakeClient([]))

    updater._run(["git", "status"], token="installation-token")

    assert captured["command"] == ["git", "status"]
    assert "installation-token" not in captured["command"]
    assert "COPIER_APP_ID" not in captured["environment"]
    assert "COPIER_APP_PRIVATE_KEY" not in captured["environment"]
    assert captured["environment"]["GIT_CONFIG_VALUE_0"].startswith("Authorization: Basic ")


def test_repository_update_runs_copier_and_opens_pull_request():
    repository = Repository(id=20, full_name="owner/repository", default_branch="main")
    client = FakeClient([repository])
    updater = CommandRecordingUpdater(client, status=" M README.md\n")

    assert updater.update_repository(repository, ".copier-answers.yaml", "repository-token")

    assert (["copier", "update", "-A", "-f", "-a", ".copier-answers.yaml"], "repository-token") in updater.commands
    assert (["git", "push", "origin", "copier-update-2026-08-01T12-34-56Z"], "repository-token") in updater.commands
    assert client.pull_requests == [
        (
            "owner/repository",
            "copier-update-2026-08-01T12-34-56Z",
            "Update from Copier (2026-08-01T12-34-56Z)",
        )
    ]


def test_repository_update_stops_when_copier_changes_only_ignored_files():
    repository = Repository(id=20, full_name="owner/repository", default_branch="main")
    client = FakeClient([repository])
    updater = CommandRecordingUpdater(client, status="")

    assert not updater.update_repository(repository, ".copier-answers.yaml", "repository-token")
    assert not any(command[:2] == ["git", "commit"] for command, _ in updater.commands)
    assert client.pull_requests == []
