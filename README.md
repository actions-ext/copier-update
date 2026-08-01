# Copier Update

GitHub App that updates Copier-managed repositories from their upstream templates. Install the app on repositories to receive weekly update pull
requests or request updates by account, visibility, or selected repository from its Cloudflare Worker control plane. Target repositories do not need a
workflow, personal access token, or repository secret.

The previous composite action is deprecated but remains available temporarily for compatibility. Workflow-based users should migrate to
[`actions-ext/copier/update`](https://github.com/actions-ext/copier/tree/main/update); repositories using the app can remove their Copier update workflow.

## GitHub App configuration

[Register a GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app) with these repository
permissions:

- **Contents:** Read and write
- **Pull requests:** Read and write
- **Workflows:** Read and write
- **Metadata:** Read-only, granted automatically

Grant **Members: Read-only** under organization permissions so the control plane can verify organization owners. Configure:

- Homepage URL: the Worker `PUBLIC_URL`
- Callback URL: `PUBLIC_URL/oauth/callback`
- Webhooks: disabled
- Where this GitHub App can be installed: any account

Generate a private key and client secret. Install the app on `actions-ext/copier-update` so it can dispatch the central worker, then install it on each
personal account or organization that should receive updates. Installation owners can grant all or selected repositories.

## Cloudflare configuration

The `1kbgz/terraform` repository's `copier-update/` root provisions Worker metadata and `updates.python-templates.dev`. Use a separate account-scoped
Cloudflare API token with **Workers Scripts: Write**; do not reuse the Crowdsource token.

After applying Terraform, configure this repository:

```bash
gh variable set CLOUDFLARE_ACCOUNT_ID --repo actions-ext/copier-update --body "ACCOUNT_ID"
gh variable set COPIER_APP_CLIENT_ID --repo actions-ext/copier-update --body "CLIENT_ID"
gh variable set COPIER_APP_ID --repo actions-ext/copier-update --body "APP_ID"
gh variable set COPIER_UPDATE_PUBLIC_URL --repo actions-ext/copier-update --body "https://updates.python-templates.dev"

gh secret set CLOUDFLARE_TEMPLATES_API_TOKEN --repo actions-ext/copier-update
gh secret set COPIER_APP_CLIENT_SECRET --repo actions-ext/copier-update
gh secret set COPIER_APP_PRIVATE_KEY --repo actions-ext/copier-update < private-key.pem
openssl rand -base64 32 | gh secret set COPIER_UPDATE_SESSION_SECRET --repo actions-ext/copier-update

gh workflow run deploy.yaml --repo actions-ext/copier-update
```

The deployment workflow sends runtime credentials to Cloudflare as encrypted Worker secrets. They are not stored in Terraform state.

## Updates

The scheduled workflow runs every Sunday at 05:00 UTC across every installation. It skips repositories without a `.copier-answers.yaml` or
`.copier-answers.yml` file and repositories that already have an open `copier-update-*` pull request.

After signing in to the control plane, personal account owners and organization owners can request updates for:

- every installed repository in an account
- all public or all private installed repositories in an account
- one or more selected installed repositories

Repository maintainers with access to this control repository can also run the `Update installed repositories` workflow directly with its `repository`
input set to `owner/repository`.

## Security

The control plane uses GitHub OAuth with PKCE, encrypted `HttpOnly` sessions, CSRF tokens, and a fresh owner check for each request. It restricts its
dispatch token to `actions-ext/copier-update`. The central worker removes the app private key from every target-repository subprocess, passes Git
credentials through temporary configuration rather than command arguments, and restricts each update token to one repository. Copier templates remain
untrusted by default.

## Development

```bash
make develop
make lint
make checks
make coverage
make build

cd web
npm ci
npm run check
npm test
npm run build
```
