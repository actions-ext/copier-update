from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any
from urllib.parse import quote

import jwt
import requests


class GitHubError(RuntimeError):
    """Raised when a GitHub API request fails."""


@dataclass(frozen=True)
class Repository:
    id: int
    full_name: str
    default_branch: str
    archived: bool = False
    disabled: bool = False


class GitHubAppClient:
    def __init__(
        self,
        app_id: str,
        private_key: str,
        *,
        api_url: str = "https://api.github.com",
        session: requests.Session | None = None,
    ) -> None:
        self.app_id = app_id
        self.private_key = private_key.replace("\\n", "\n")
        self.api_url = api_url.rstrip("/")
        self.session = session or requests.Session()

    def installation_ids(self) -> list[int]:
        installations: list[int] = []
        for item in self._paginate("/app/installations"):
            installations.append(int(item["id"]))
        return installations

    def installation_token(self, installation_id: int, repository_id: int | None = None) -> str:
        body: dict[str, Any] = {}
        if repository_id is not None:
            body["repository_ids"] = [repository_id]
        response = self._request("POST", f"/app/installations/{installation_id}/access_tokens", json=body)
        return str(response["token"])

    def repositories(self, token: str) -> list[Repository]:
        repositories = self._paginate("/installation/repositories", token=token, collection="repositories")
        return [
            Repository(
                id=int(item["id"]),
                full_name=str(item["full_name"]),
                default_branch=str(item.get("default_branch") or "main"),
                archived=bool(item.get("archived", False)),
                disabled=bool(item.get("disabled", False)),
            )
            for item in repositories
        ]

    def copier_answers_file(self, repository: Repository, token: str) -> str | None:
        for filename in (".copier-answers.yaml", ".copier-answers.yml"):
            path = f"/repos/{repository.full_name}/contents/{quote(filename, safe='')}"
            response = self._request("GET", path, token=token, params={"ref": repository.default_branch}, allow_not_found=True)
            if response is not None:
                return filename
        return None

    def has_open_update(self, repository: Repository, token: str, branch_prefix: str) -> bool:
        pulls = self._paginate(
            f"/repos/{repository.full_name}/pulls",
            token=token,
            params={"state": "open", "base": repository.default_branch},
        )
        for pull in pulls:
            head = pull.get("head", {})
            head_repository = head.get("repo") or {}
            if str(head.get("ref", "")).startswith(f"{branch_prefix}-") and head_repository.get("full_name") == repository.full_name:
                return True
        return False

    def create_pull_request(self, repository: Repository, token: str, branch: str, title: str) -> str:
        response = self._request(
            "POST",
            f"/repos/{repository.full_name}/pulls",
            token=token,
            json={
                "base": repository.default_branch,
                "body": "Automated update from the repository's Copier template.",
                "head": branch,
                "title": title,
            },
        )
        return str(response["html_url"])

    def _jwt(self) -> str:
        now = int(time.time())
        return jwt.encode(
            {"iat": now - 60, "exp": now + 9 * 60, "iss": self.app_id},
            self.private_key,
            algorithm="RS256",
        )

    def _paginate(
        self,
        path: str,
        *,
        token: str | None = None,
        collection: str | None = None,
        params: dict[str, Any] | None = None,
    ) -> list[dict[str, Any]]:
        items: list[dict[str, Any]] = []
        page = 1
        while True:
            page_params = dict(params or {})
            page_params.update({"page": page, "per_page": 100})
            response = self._request("GET", path, token=token, params=page_params)
            page_items = response[collection] if collection is not None else response
            items.extend(page_items)
            if len(page_items) < 100:
                return items
            page += 1

    def _request(
        self,
        method: str,
        path: str,
        *,
        token: str | None = None,
        allow_not_found: bool = False,
        **kwargs: Any,
    ) -> Any:
        headers = {
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {token or self._jwt()}",
            "X-GitHub-Api-Version": "2022-11-28",
        }
        response = self.session.request(method, f"{self.api_url}{path}", headers=headers, timeout=30, **kwargs)
        if allow_not_found and response.status_code == 404:
            return None
        if not response.ok:
            try:
                message = response.json().get("message", response.text)
            except ValueError:
                message = response.text
            raise GitHubError(f"{method} {path} returned {response.status_code}: {message}")
        return response.json()
