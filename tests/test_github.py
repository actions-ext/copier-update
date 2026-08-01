from __future__ import annotations

from typing import Any

from copier_update_app.github import GitHubAppClient, Repository


class FakeResponse:
    def __init__(self, status_code: int, data: Any) -> None:
        self.status_code = status_code
        self.data = data
        self.ok = 200 <= status_code < 300
        self.text = str(data)

    def json(self) -> Any:
        return self.data


class FakeSession:
    def __init__(self, *responses: FakeResponse) -> None:
        self.responses = list(responses)
        self.requests: list[tuple[str, str, dict[str, Any]]] = []

    def request(self, method: str, url: str, **kwargs: Any) -> FakeResponse:
        self.requests.append((method, url, kwargs))
        return self.responses.pop(0)


def test_lists_installations_with_app_authentication(monkeypatch):
    session = FakeSession(FakeResponse(200, [{"id": 12}, {"id": 34}]))
    monkeypatch.setattr("copier_update_app.github.jwt.encode", lambda *args, **kwargs: "app-jwt")
    client = GitHubAppClient("123", "private-key", session=session)

    assert client.installation_ids() == [12, 34]
    _, url, kwargs = session.requests[0]
    assert url == "https://api.github.com/app/installations"
    assert kwargs["headers"]["Authorization"] == "Bearer app-jwt"
    assert kwargs["params"] == {"page": 1, "per_page": 100}


def test_lists_installation_repositories():
    session = FakeSession(
        FakeResponse(
            200,
            {
                "repositories": [
                    {"id": 1, "full_name": "owner/active", "default_branch": "trunk"},
                    {"id": 2, "full_name": "owner/archived", "default_branch": "main", "archived": True},
                ]
            },
        )
    )
    client = GitHubAppClient("123", "private-key", session=session)

    assert client.repositories("installation-token") == [
        Repository(id=1, full_name="owner/active", default_branch="trunk"),
        Repository(id=2, full_name="owner/archived", default_branch="main", archived=True),
    ]
    assert session.requests[0][2]["headers"]["Authorization"] == "Bearer installation-token"


def test_finds_yaml_answers_file_after_yml_is_missing():
    repository = Repository(id=1, full_name="owner/repository", default_branch="main")
    session = FakeSession(FakeResponse(404, {"message": "Not Found"}), FakeResponse(200, {"path": ".copier-answers.yml"}))
    client = GitHubAppClient("123", "private-key", session=session)

    assert client.copier_answers_file(repository, "token") == ".copier-answers.yml"


def test_detects_open_update_pull_request():
    repository = Repository(id=1, full_name="owner/repository", default_branch="main")
    session = FakeSession(
        FakeResponse(
            200,
            [
                {"head": {"ref": "feature", "repo": {"full_name": "owner/repository"}}},
                {"head": {"ref": "copier-update-2026-08-01", "repo": {"full_name": "owner/repository"}}},
            ],
        )
    )
    client = GitHubAppClient("123", "private-key", session=session)

    assert client.has_open_update(repository, "token", "copier-update")
