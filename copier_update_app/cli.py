from __future__ import annotations

import logging
import os

from copier_update_app.github import GitHubAppClient
from copier_update_app.updater import Updater

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
    updater = Updater(
        client,
        branch_prefix=os.environ.get("COPIER_BRANCH_PREFIX", "copier-update"),
        repository_filter=os.environ.get("COPIER_REPOSITORY") or None,
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
