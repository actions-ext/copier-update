# copier-update
Action to update copier-templated repo from upstream


## Configuration
If you're using a GitHub organization, navigate to your organization's action settings (like `https://github.com/organizations/your-org-name-here/settings/actions`) and toggle `Read and write permissions` under `Workflow Permissions`.

Create a [personal access token](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens) and store it in an [actions secret](https://docs.github.com/en/actions/security-for-github-actions/security-guides/using-secrets-in-github-actions). In the below example, we've named it `WORKFLOW_SECRET`. 

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
