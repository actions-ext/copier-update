# Copier Update

Copier Update is a GitHub App that checks your repositories for changes to their Copier templates each week and opens pull requests when updates are
available. You can also sign in to the website to request updates for an account, public or private repositories, or selected repositories. Your
repositories do not need an update workflow, personal access token, or repository secret.

[Website](https://updates.python-templates.dev) · [Install](https://github.com/apps/python-templates-copier-update/installations/new) ·
[Support](https://updates.python-templates.dev/support) · [Privacy](https://updates.python-templates.dev/privacy) ·
[Marketplace assets](docs/img)

The previous composite action is deprecated but remains available temporarily for compatibility. Workflow-based users should migrate to
[`actions-ext/copier/update`](https://github.com/actions-ext/copier/tree/main/update); repositories using the app can remove their Copier update workflow.

## GitHub App configuration

[Register a GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app) with these repository
permissions:

- **Contents:** Read and write
- **Pull requests:** Read and write
- **Workflows:** Read and write
- **Metadata:** Read-only, granted automatically

Grant **Members: Read-only** under organization permissions so the app can verify that someone requesting an update is an organization owner. Configure:

- Homepage URL: the Worker `PUBLIC_URL`
- Callback URL: `PUBLIC_URL/oauth/callback`
- Repository webhooks: disabled
- Where this GitHub App can be installed: any account

The Marketplace listing uses `PUBLIC_URL/marketplace-webhook` separately for signed purchase and cancellation events.

Generate a private key and client secret. Install the app on `actions-ext/copier-update` so it can start update jobs, then install it on each
personal account or organization that should receive updates. Installation owners can grant all or selected repositories.

## Cloudflare configuration

The `copier-update/` configuration in `1kbgz/terraform` provisions Worker metadata and `updates.python-templates.dev`. Use a separate account-scoped
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
copier_marketplace_webhook_secret="$(openssl rand -base64 32)"
gh secret set COPIER_MARKETPLACE_WEBHOOK_SECRET --repo actions-ext/copier-update --body "$copier_marketplace_webhook_secret"
openssl rand -base64 32 | gh secret set COPIER_UPDATE_SESSION_SECRET --repo actions-ext/copier-update

gh workflow run deploy.yaml --repo actions-ext/copier-update
```

Use `$copier_marketplace_webhook_secret` as the draft Marketplace listing's webhook secret.

The deployment workflow sends runtime credentials to Cloudflare as encrypted Worker secrets. They are not stored in Terraform state.

## Updates

The scheduled workflow runs every Sunday at 05:00 UTC across every installation. It skips repositories without a `.copier-answers.yaml` or
`.copier-answers.yml` file and repositories that already have an open `copier-update-*` pull request.

After signing in to the website, personal account owners and organization owners can request updates for:

- every installed repository in an account
- all public or all private installed repositories in an account
- one or more selected installed repositories

Maintainers with access to `actions-ext/copier-update` can also run the `Update installed repositories` workflow directly with its `repository`
input set to `owner/repository`.

## Security

The website uses GitHub OAuth with PKCE, encrypted `HttpOnly` sessions, and CSRF tokens. It checks account ownership for each update request and uses a
token restricted to `actions-ext/copier-update` to start the update job. The update job removes the app private key from every target-repository
subprocess, passes Git credentials through temporary configuration rather than command arguments, and restricts each update token to one repository.
Copier templates are untrusted by default.

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
