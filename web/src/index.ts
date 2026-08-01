import {
  dispatchUpdate,
  exchangeCode,
  installations,
  organizationMembership,
  repositories,
  type GitHubUser,
  type Installation,
  type Repository,
  user,
} from "./github";
import { clearCookie, cookie, randomValue, seal, setCookie, sha256, unseal } from "./session";

export interface Env {
  CONTROL_REPOSITORY: string;
  GITHUB_APP_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  PUBLIC_URL: string;
  SESSION_SECRET: string;
}

interface OAuthState {
  expires: number;
  state: string;
  verifier: string;
}

interface Session {
  csrf: string;
  expires: number;
  token: string;
}

class UserError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

const OAUTH_COOKIE = "copier_oauth";
const SESSION_COOKIE = "copier_session";
const SCOPES = new Set(["all", "public", "private", "selected"]);

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
  );
}

function page(title: string, content: string, status = 200, headers: HeadersInit = {}): Response {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(title)}</title><style>body{font:16px system-ui,sans-serif;max-width:64rem;margin:3rem auto;padding:0 1rem;color:#202124}header{display:flex;justify-content:space-between;align-items:center}section{border:1px solid #ddd;border-radius:.5rem;padding:1rem;margin:1rem 0}label{display:block;margin:.5rem 0}button,.button{background:#24292f;color:white;border:0;border-radius:.4rem;padding:.65rem 1rem;text-decoration:none;cursor:pointer}select{padding:.4rem}details{margin:1rem 0}.muted{color:#656d76}.error{color:#b42318}</style></head><body>${content}</body></html>`,
    {
      status,
      headers: {
        "Cache-Control": "no-store",
        "Content-Security-Policy":
          "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
        "Content-Type": "text/html; charset=utf-8",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
        ...headers,
      },
    },
  );
}

function callbackUrl(env: Env): string {
  return new URL("/oauth/callback", env.PUBLIC_URL).toString();
}

async function session(request: Request, env: Env): Promise<Session | null> {
  const value = cookie(request, SESSION_COOKIE);
  if (!value) {
    return null;
  }
  const result = await unseal<Session>(value, env.SESSION_SECRET);
  return result && result.expires > Date.now() ? result : null;
}

async function login(env: Env): Promise<Response> {
  const state = randomValue();
  const verifier = randomValue(48);
  const oauthState = await seal(
    { expires: Date.now() + 10 * 60_000, state, verifier } satisfies OAuthState,
    env.SESSION_SECRET,
  );
  const authorize = new URL("https://github.com/login/oauth/authorize");
  authorize.search = new URLSearchParams({
    client_id: env.GITHUB_CLIENT_ID,
    code_challenge: await sha256(verifier),
    code_challenge_method: "S256",
    redirect_uri: callbackUrl(env),
    state,
  }).toString();
  return new Response(null, {
    status: 302,
    headers: {
      "Cache-Control": "no-store",
      Location: authorize.toString(),
      "Set-Cookie": setCookie(OAUTH_COOKIE, oauthState, 10 * 60),
    },
  });
}

async function oauthCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const value = cookie(request, OAUTH_COOKIE);
  const oauthState = value ? await unseal<OAuthState>(value, env.SESSION_SECRET) : null;
  if (!oauthState || oauthState.expires <= Date.now() || url.searchParams.get("state") !== oauthState.state) {
    throw new UserError("Authorization request expired or could not be verified.");
  }
  const code = url.searchParams.get("code");
  if (!code) {
    throw new UserError("GitHub did not return an authorization code.");
  }
  const token = await exchangeCode(
    env.GITHUB_CLIENT_ID,
    env.GITHUB_CLIENT_SECRET,
    code,
    oauthState.verifier,
    callbackUrl(env),
  );
  const lifetime = Math.min(token.expires_in || 8 * 60 * 60, 8 * 60 * 60);
  const encryptedSession = await seal(
    { csrf: randomValue(), expires: Date.now() + lifetime * 1000, token: token.access_token } satisfies Session,
    env.SESSION_SECRET,
  );
  return new Response(null, {
    status: 302,
    headers: [
      ["Cache-Control", "no-store"],
      ["Location", env.PUBLIC_URL],
      ["Set-Cookie", clearCookie(OAUTH_COOKIE)],
      ["Set-Cookie", setCookie(SESSION_COOKIE, encryptedSession, lifetime)],
    ],
  });
}

function repositoryChoices(items: Repository[]): string {
  return items
    .sort((left, right) => left.full_name.localeCompare(right.full_name))
    .map(
      (repository) =>
        `<label><input type="checkbox" name="repository" value="${escapeHtml(repository.full_name)}"> ${escapeHtml(repository.full_name)}${repository.private ? ' <span class="muted">private</span>' : ""}</label>`,
    )
    .join("");
}

function installationForm(item: Installation, items: Repository[], csrf: string): string {
  const account = item.account.login;
  return `<section><h2>${escapeHtml(account)}</h2><p class="muted">${escapeHtml(item.account.type)} installation · ${items.length} accessible repositories</p><form method="post" action="/run"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><input type="hidden" name="installation_id" value="${item.id}"><label>Scope <select name="scope"><option value="all">All installed repositories</option><option value="public">All public repositories</option><option value="private">All private repositories</option><option value="selected">Selected repositories</option></select></label><details><summary>Select repositories</summary>${repositoryChoices(items)}</details><button type="submit">Request update</button></form></section>`;
}

async function dashboard(request: Request, env: Env): Promise<Response> {
  const activeSession = await session(request, env);
  if (!activeSession) {
    return page(
      "Copier Update",
      '<h1>Copier Update</h1><p>Open Copier update pull requests for repositories where the GitHub App is installed.</p><p><a class="button" href="/login">Sign in with GitHub</a></p>',
    );
  }
  const [viewer, availableInstallations] = await Promise.all([
    user(activeSession.token),
    installations(activeSession.token),
  ]);
  const cards = await Promise.all(
    availableInstallations.map(async (item) =>
      installationForm(item, await repositories(activeSession.token, item.id), activeSession.csrf),
    ),
  );
  return page(
    "Copier Update",
    `<header><div><h1>Copier Update</h1><p class="muted">Signed in as ${escapeHtml(viewer.login)}</p></div><form method="post" action="/logout"><input type="hidden" name="csrf" value="${escapeHtml(activeSession.csrf)}"><button type="submit">Sign out</button></form></header>${cards.join("") || "<p>No App installations are available.</p>"}`,
  );
}

async function authorizeInstallation(token: string, viewer: GitHubUser, item: Installation): Promise<void> {
  if (item.account.type === "User") {
    if (item.account.login.toLowerCase() !== viewer.login.toLowerCase()) {
      throw new UserError("Only the personal account owner can request this update.", 403);
    }
    return;
  }
  const membership = await organizationMembership(token, item.account.login, viewer.login);
  if (membership.state !== "active" || membership.role !== "admin") {
    throw new UserError("Only an active organization owner can request this update.", 403);
  }
}

async function runUpdate(request: Request, env: Env): Promise<Response> {
  const activeSession = await session(request, env);
  if (!activeSession) {
    throw new UserError("Your session expired. Sign in again.", 401);
  }
  const form = await request.formData();
  if (form.get("csrf") !== activeSession.csrf) {
    throw new UserError("Request could not be verified.", 403);
  }
  const installationId = Number(form.get("installation_id"));
  const scope = String(form.get("scope") || "");
  if (!Number.isSafeInteger(installationId) || !SCOPES.has(scope)) {
    throw new UserError("Invalid installation or scope.");
  }
  const [viewer, availableInstallations] = await Promise.all([
    user(activeSession.token),
    installations(activeSession.token),
  ]);
  const item = availableInstallations.find((installation) => installation.id === installationId);
  if (!item) {
    throw new UserError("GitHub App installation is not available to this user.", 403);
  }
  await authorizeInstallation(activeSession.token, viewer, item);

  const requestedRepositories = form.getAll("repository").map(String);
  const selectedRepositories = scope === "selected" ? [...new Set(requestedRepositories)] : [];
  if (scope === "selected") {
    if (!selectedRepositories.length || selectedRepositories.length > 100) {
      throw new UserError("Select between 1 and 100 repositories.");
    }
    const available = new Set(
      (await repositories(activeSession.token, item.id)).map((repository) => repository.full_name),
    );
    if (selectedRepositories.some((repository) => !available.has(repository))) {
      throw new UserError("One or more selected repositories are not available to this installation.", 403);
    }
  }

  const requestId = crypto.randomUUID();
  await dispatchUpdate(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY, env.CONTROL_REPOSITORY, {
    owner: item.account.login,
    repositories: selectedRepositories,
    requester: viewer.login,
    request_id: requestId,
    scope,
  });
  return page(
    "Update requested",
    `<h1>Update requested</h1><p>Queued ${escapeHtml(scope)} update for ${escapeHtml(item.account.login)}.</p><p class="muted">Request ${escapeHtml(requestId)}</p><p><a href="/">Back</a></p>`,
    202,
  );
}

async function logout(request: Request, env: Env): Promise<Response> {
  const activeSession = await session(request, env);
  const form = await request.formData();
  if (!activeSession || form.get("csrf") !== activeSession.csrf) {
    throw new UserError("Request could not be verified.", 403);
  }
  return new Response(null, {
    status: 302,
    headers: {
      "Cache-Control": "no-store",
      Location: env.PUBLIC_URL,
      "Set-Cookie": clearCookie(SESSION_COOKIE),
    },
  });
}

export async function handleRequest(request: Request, env: Env): Promise<Response> {
  const { pathname } = new URL(request.url);
  try {
    if (request.method === "GET" && pathname === "/") return await dashboard(request, env);
    if (request.method === "GET" && pathname === "/login") return await login(env);
    if (request.method === "GET" && pathname === "/oauth/callback") return await oauthCallback(request, env);
    if (request.method === "POST" && pathname === "/run") return await runUpdate(request, env);
    if (request.method === "POST" && pathname === "/logout") return await logout(request, env);
    if (request.method === "GET" && pathname === "/healthz") return Response.json({ status: "ok" });
    return page("Not found", "<h1>Not found</h1>", 404);
  } catch (error) {
    if (error instanceof UserError) {
      return page(
        "Request failed",
        `<h1>Request failed</h1><p class="error">${escapeHtml(error.message)}</p><p><a href="/">Back</a></p>`,
        error.status,
      );
    }
    console.error(error);
    return page(
      "Request failed",
      '<h1>Request failed</h1><p class="error">Unexpected service error.</p><p><a href="/">Back</a></p>',
      500,
    );
  }
}

export default { fetch: handleRequest } satisfies ExportedHandler<Env>;
