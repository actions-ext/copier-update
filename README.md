# Copier Update

GitHub App worker that updates Copier-managed repositories from their upstream templates. Install the app on repositories to receive weekly update pull
requests; target repositories do not need a workflow, personal access token, or repository secret.

The previous composite action is deprecated but remains available temporarily for compatibility. Workflow-based users should migrate to
[`actions-ext/copier/update`](https://github.com/actions-ext/copier/tree/main/update); repositories using the app can remove their Copier update workflow.

## GitHub App configuration

[Register a GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app) with these repository
permissions:

- **Contents:** Read and write
- **Pull requests:** Read and write
- **Workflows:** Read and write
- **Metadata:** Read-only, granted automatically

Webhooks and user authorization are not required. Generate a private key, install the app on each repository that should receive updates, then configure
this repository:

```bash
gh variable set COPIER_APP_ID --repo actions-ext/copier-update --body "APP_ID"
gh secret set COPIER_APP_PRIVATE_KEY --repo actions-ext/copier-update < private-key.pem
```

The scheduled workflow runs every Sunday at 05:00 UTC. It discovers repositories through the app installations, skips repositories without a
`.copier-answers.yaml` or `.copier-answers.yml` file, and skips repositories that already have an open `copier-update-*` pull request.

To update one installed repository manually, run the `Update installed repositories` workflow with its `repository` input set to `owner/repository`.

## Security

The app private key is used only to mint short-lived installation tokens and is removed from every target-repository subprocess environment. Git
credentials are passed through temporary Git configuration rather than command arguments. Each update token is restricted to the repository being
updated. Copier templates remain untrusted by default.

## Development

```bash
python -m pip install -e '.[develop]'
ruff check .
ruff format --check .
pytest
```
