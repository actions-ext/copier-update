# copier-update

Action to update copier-templated repo from upstream

> [!NOTE]
> This action is deprecated in favor of [actions-ext/copier/update](https://github.com/actions-ext/copier)

## Configuration

If you're using a GitHub organization, navigate to your organization's action settings (like `https://github.com/organizations/your-org-name-here/settings/actions`) and toggle `Read and write permissions` under `Workflow Permissions`.

Create a [personal access token](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens) and store it in an [actions secret](https://docs.github.com/en/actions/security-for-github-actions/security-guides/using-secrets-in-github-actions). In the below example, we've named it `WORKFLOW_SECRET`.

### Token Permissions

**Classic PAT:** The token needs the `repo` scope (for private repositories) or `public_repo` scope (for public repositories), plus `workflow` scope. The `workflow` scope is required because copier-templated repos often include `.github/workflows/` files, which a token without `workflow` cannot push.

**Fine-grained token:** The token needs the following repository permissions:

- `Contents` — **Read and write** (to push the update branch)
- `Pull requests` — **Read and write** (to create the PR)
- `Workflows` — **Read and write** (to push `.github/workflows/` files)
- `Metadata` — **Read** (automatically granted; needed to read repository info)

Now you can create a workflow like `.github/workflow/copier.yml`:

```yaml
name: Copier Updates

on:
  workflow_dispatch:
  schedule:
    - cron: "0 5 * * 0"

jobs:
  update:
    permissions:
      contents: write
      pull-requests: write
    runs-on: ubuntu-latest
    steps:
    - uses: actions-ext/copier-update@main
      with:
        token: ${{ secrets.WORKFLOW_TOKEN }}
```
