from __future__ import annotations

import base64
import logging
import os
import subprocess
import tempfile
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from copier_update_app.github import GitHubAppClient, Repository

LOGGER = logging.getLogger(__name__)

LOCKFILES = (
    "pnpm-lock.yaml",
    "js/pnpm-lock.yaml",
    "Cargo.lock",
    "rust/Cargo.lock",
)


@dataclass
class UpdateSummary:
    checked: int = 0
    updated: int = 0
    skipped: int = 0
    failed: int = 0


class Updater:
    def __init__(
        self,
        client: GitHubAppClient,
        *,
        branch_prefix: str = "copier-update",
        repository_filter: str | None = None,
        repository_filters: set[str] | None = None,
        owner_filter: str | None = None,
        visibility_filter: str | None = None,
        now: Callable[[], datetime] | None = None,
    ) -> None:
        if repository_filter and repository_filters:
            raise ValueError("Use repository_filter or repository_filters, not both")
        if visibility_filter not in (None, "public", "private"):
            raise ValueError("visibility_filter must be public or private")
        self.client = client
        self.branch_prefix = branch_prefix
        self.repository_filters = {
            repository.casefold() for repository in (repository_filters or ({repository_filter} if repository_filter else set()))
        }
        self.owner_filter = owner_filter.casefold() if owner_filter else None
        self.visibility_filter = visibility_filter
        self.now = now or (lambda: datetime.now(UTC))

    def run(self) -> UpdateSummary:
        summary = UpdateSummary()
        matched_owner = False
        matched_repositories: set[str] = set()
        for installation in self.client.installations():
            if self.owner_filter and installation.account_login.casefold() != self.owner_filter:
                continue
            matched_owner = True
            installation_token = self.client.installation_token(installation.id)
            for repository in self.client.repositories(installation_token):
                repository_name = repository.full_name.casefold()
                if self.repository_filters and repository_name not in self.repository_filters:
                    continue
                if self.visibility_filter == "public" and repository.private:
                    continue
                if self.visibility_filter == "private" and not repository.private:
                    continue
                matched_repositories.add(repository_name)
                summary.checked += 1
                try:
                    result = self._consider_repository(installation.id, repository, installation_token)
                except Exception:
                    summary.failed += 1
                    LOGGER.exception("Failed to update %s", repository.full_name)
                else:
                    if result:
                        summary.updated += 1
                    else:
                        summary.skipped += 1

        if self.owner_filter and not matched_owner:
            raise RuntimeError(f"Account {self.owner_filter!r} is not available to this app")
        missing_repositories = self.repository_filters - matched_repositories
        if missing_repositories:
            missing = ", ".join(sorted(missing_repositories))
            raise RuntimeError(f"Repositories are not available to this app: {missing}")
        return summary

    def _consider_repository(self, installation_id: int, repository: Repository, installation_token: str) -> bool:
        if repository.archived or repository.disabled:
            LOGGER.info("Skipping inactive repository %s", repository.full_name)
            return False

        answers_file = self.client.copier_answers_file(repository, installation_token)
        if answers_file is None:
            LOGGER.info("Skipping %s: no Copier answers file", repository.full_name)
            return False
        if self.client.has_open_update(repository, installation_token, self.branch_prefix):
            LOGGER.info("Skipping %s: update pull request already open", repository.full_name)
            return False

        repository_token = self.client.installation_token(installation_id, repository.id)
        return self.update_repository(repository, answers_file, repository_token)

    def update_repository(self, repository: Repository, answers_file: str, token: str) -> bool:
        timestamp = self.now().strftime("%Y-%m-%dT%H-%M-%SZ")
        branch = f"{self.branch_prefix}-{timestamp}"
        title = f"Update from Copier ({timestamp})"

        with tempfile.TemporaryDirectory(prefix="copier-update-") as temporary_directory:
            repository_path = Path(temporary_directory) / repository.full_name.replace("/", "-")
            self._run(
                [
                    "git",
                    "clone",
                    "--depth",
                    "1",
                    "--branch",
                    repository.default_branch,
                    f"https://github.com/{repository.full_name}.git",
                    str(repository_path),
                ],
                token=token,
            )
            self._run(["copier", "update", "-A", "-f", "-a", answers_file], cwd=repository_path, token=token)

            if not self._has_meaningful_changes(repository_path):
                LOGGER.info("No update available for %s", repository.full_name)
                return False

            self._refresh_lockfiles(repository_path)
            self._run(["git", "config", "user.name", "copier-update[bot]"], cwd=repository_path)
            self._run(["git", "config", "user.email", "copier-update[bot]@users.noreply.github.com"], cwd=repository_path)
            self._run(["git", "checkout", "-b", branch], cwd=repository_path)
            self._run(["git", "add", "--all"], cwd=repository_path)
            self._run(["git", "commit", "-s", "-m", title], cwd=repository_path)
            self._run(["git", "push", "origin", branch], cwd=repository_path, token=token)

        pull_request_url = self.client.create_pull_request(repository, token, branch, title)
        LOGGER.info("Opened %s", pull_request_url)
        return True

    def _has_meaningful_changes(self, repository_path: Path) -> bool:
        command = ["git", "status", "--porcelain", "--", ".", ":!.copier-answers.yaml", ":!.copier-answers.yml"]
        command.extend(f":!{lockfile}" for lockfile in LOCKFILES)
        result = self._run(command, cwd=repository_path, capture_output=True)
        return bool(result.stdout.strip())

    def _refresh_lockfiles(self, repository_path: Path) -> None:
        commands: list[tuple[Sequence[str], Path]] = []
        if (repository_path / "pnpm-lock.yaml").exists():
            commands.append((["pnpm", "install", "--no-frozen-lockfile"], repository_path))
        if (repository_path / "js/pnpm-lock.yaml").exists():
            commands.append((["pnpm", "install", "--no-frozen-lockfile"], repository_path / "js"))
        if (repository_path / "Cargo.lock").exists():
            commands.append((["cargo", "update"], repository_path))
        if (repository_path / "rust/Cargo.lock").exists():
            commands.append((["cargo", "update"], repository_path / "rust"))

        for command, cwd in commands:
            try:
                self._run(command, cwd=cwd)
            except (OSError, subprocess.CalledProcessError):
                LOGGER.warning("Could not refresh %s", cwd, exc_info=True)

    def _run(
        self,
        command: Sequence[str],
        *,
        cwd: Path | None = None,
        token: str | None = None,
        capture_output: bool = False,
    ) -> subprocess.CompletedProcess[str]:
        environment = os.environ.copy()
        environment.pop("COPIER_APP_PRIVATE_KEY", None)
        environment.pop("COPIER_APP_ID", None)
        if token is not None:
            credentials = base64.b64encode(f"x-access-token:{token}".encode()).decode()
            environment.update(
                {
                    "GIT_CONFIG_COUNT": "1",
                    "GIT_CONFIG_KEY_0": "http.https://github.com/.extraheader",
                    "GIT_CONFIG_VALUE_0": f"Authorization: Basic {credentials}",
                }
            )
        return subprocess.run(
            list(command),
            cwd=cwd,
            env=environment,
            check=True,
            text=True,
            capture_output=capture_output,
        )
