from __future__ import annotations

import json
import logging
import os

from copier_update.github import GitHubAppClient
from copier_update.updater import Updater

LOGGER = logging.getLogger(__name__)


def _required_environment(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"Required environment variable {name} is not set")
    return value


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    client = GitHubAppClient(
        _required_environment("COPIER_APP_ID"),
        _required_environment("COPIER_APP_PRIVATE_KEY"),
        api_url=os.environ.get("GITHUB_API_URL", "https://api.github.com"),
    )
    repositories_json = os.environ.get("COPIER_REPOSITORIES", "").strip()
    repository_filters = None
    if repositories_json and repositories_json != "null":
        repositories = json.loads(repositories_json)
        if not isinstance(repositories, list) or not all(isinstance(repository, str) for repository in repositories):
            raise RuntimeError("COPIER_REPOSITORIES must be a JSON list of repository names")
        repository_filters = set(repositories)

    scope = os.environ.get("COPIER_SCOPE", "").strip() or "all"
    if scope not in {"all", "public", "private", "selected"}:
        raise RuntimeError("COPIER_SCOPE must be all, public, private, or selected")
    if scope == "selected" and not repository_filters:
        raise RuntimeError("COPIER_REPOSITORIES is required for selected scope")

    updater = Updater(
        client,
        branch_prefix=os.environ.get("COPIER_BRANCH_PREFIX", "copier-update"),
        repository_filter=os.environ.get("COPIER_REPOSITORY") or None,
        repository_filters=repository_filters,
        owner_filter=os.environ.get("COPIER_OWNER") or None,
        visibility_filter=scope if scope in {"public", "private"} else None,
    )
    summary = updater.run()
    LOGGER.info(
        "Checked %d repositories: %d updated, %d skipped, %d failed",
        summary.checked,
        summary.updated,
        summary.skipped,
        summary.failed,
    )
    return 1 if summary.failed else 0
