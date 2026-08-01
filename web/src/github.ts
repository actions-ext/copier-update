const encoder = new TextEncoder();

export interface GitHubUser {
  login: string;
}

export interface Installation {
  id: number;
  account: {
    login: string;
    type: "Organization" | "User";
  };
}

export interface Repository {
  full_name: string;
  private: boolean;
}

interface TokenResponse {
  access_token: string;
  expires_in?: number;
}

export class GitHubError extends Error {}

function encodeBase64Url(value: Uint8Array | string): string {
  const binary = typeof value === "string" ? value : String.fromCharCode(...value);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decodePem(pem: string): { bytes: Uint8Array; pkcs1: boolean } {
  const pkcs1 = pem.includes("BEGIN RSA PRIVATE KEY");
  const base64 = pem.replace(/-----BEGIN [^-]+-----|-----END [^-]+-----|\s/g, "");
  if (!base64 || (!pkcs1 && !pem.includes("BEGIN PRIVATE KEY"))) {
    throw new Error("GitHub App private key must be an RSA PEM private key");
  }
  return { bytes: Uint8Array.from(atob(base64), (character) => character.charCodeAt(0)), pkcs1 };
}

function derLength(length: number): Uint8Array {
  if (length < 128) {
    return Uint8Array.of(length);
  }
  const bytes: number[] = [];
  for (let remaining = length; remaining > 0; remaining >>= 8) {
    bytes.unshift(remaining & 0xff);
  }
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

function der(tag: number, value: Uint8Array): Uint8Array {
  return Uint8Array.of(tag, ...derLength(value.length), ...value);
}

function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array {
  const version = Uint8Array.of(0x02, 0x01, 0x00);
  const rsaAlgorithm = Uint8Array.of(
    0x30,
    0x0d,
    0x06,
    0x09,
    0x2a,
    0x86,
    0x48,
    0x86,
    0xf7,
    0x0d,
    0x01,
    0x01,
    0x01,
    0x05,
    0x00,
  );
  return der(0x30, Uint8Array.of(...version, ...rsaAlgorithm, ...der(0x04, pkcs1)));
}

export async function createAppJwt(
  appId: string,
  privateKey: string,
  now = Math.floor(Date.now() / 1000),
): Promise<string> {
  const decoded = decodePem(privateKey.replaceAll("\\n", "\n"));
  const keyData = new Uint8Array(decoded.pkcs1 ? pkcs1ToPkcs8(decoded.bytes) : decoded.bytes).buffer;
  const key = await crypto.subtle.importKey("pkcs8", keyData, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const header = encodeBase64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = encodeBase64Url(JSON.stringify({ iat: now - 60, exp: now + 9 * 60, iss: appId }));
  const unsigned = `${header}.${payload}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, encoder.encode(unsigned));
  return `${unsigned}.${encodeBase64Url(new Uint8Array(signature))}`;
}

async function responseError(response: Response): Promise<GitHubError> {
  let message = response.statusText;
  try {
    const body = (await response.json()) as { message?: string };
    message = body.message || message;
  } catch {
    // GitHub sometimes returns an empty response body.
  }
  return new GitHubError(`GitHub returned ${response.status}: ${message}`);
}

async function githubRequest<T>(path: string, token: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "copier-update",
      "X-GitHub-Api-Version": "2022-11-28",
      ...init.headers,
    },
  });
  if (!response.ok) {
    throw await responseError(response);
  }
  return (response.status === 204 ? undefined : await response.json()) as T;
}

export async function exchangeCode(
  clientId: string,
  clientSecret: string,
  code: string,
  verifier: string,
  redirectUri: string,
): Promise<TokenResponse> {
  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
    }),
  });
  const body = (await response.json()) as TokenResponse & { error?: string };
  if (!response.ok || body.error || !body.access_token) {
    throw new GitHubError("GitHub authorization failed");
  }
  return body;
}

export function user(token: string): Promise<GitHubUser> {
  return githubRequest<GitHubUser>("/user", token);
}

async function paginatedCollection<T>(path: string, collection: string, token: string): Promise<T[]> {
  const items: T[] = [];
  for (let page = 1; ; page += 1) {
    const separator = path.includes("?") ? "&" : "?";
    const response = await githubRequest<Record<string, T[]>>(`${path}${separator}page=${page}&per_page=100`, token);
    const pageItems = response[collection];
    items.push(...pageItems);
    if (pageItems.length < 100) {
      return items;
    }
  }
}

export async function installations(token: string): Promise<Installation[]> {
  return paginatedCollection("/user/installations", "installations", token);
}

export async function repositories(token: string, installationId: number): Promise<Repository[]> {
  return paginatedCollection(`/user/installations/${installationId}/repositories`, "repositories", token);
}

export function organizationMembership(
  token: string,
  organization: string,
  username: string,
): Promise<{ role: string; state: string }> {
  return githubRequest(`/orgs/${encodeURIComponent(organization)}/memberships/${encodeURIComponent(username)}`, token);
}

export async function dispatchUpdate(
  appId: string,
  privateKey: string,
  controlRepository: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const repositoryParts = controlRepository.split("/");
  if (repositoryParts.length !== 2 || repositoryParts.some((part) => !part)) {
    throw new Error("CONTROL_REPOSITORY must use owner/repository format");
  }
  const appJwt = await createAppJwt(appId, privateKey);
  const installation = await githubRequest<{ id: number }>(`/repos/${controlRepository}/installation`, appJwt);
  const repositoryName = repositoryParts[1];
  const token = await githubRequest<{ token: string }>(`/app/installations/${installation.id}/access_tokens`, appJwt, {
    method: "POST",
    body: JSON.stringify({ repositories: [repositoryName], permissions: { contents: "write" } }),
  });
  await githubRequest(`/repos/${controlRepository}/dispatches`, token.token, {
    method: "POST",
    body: JSON.stringify({ event_type: "copier-update", client_payload: payload }),
  });
}
