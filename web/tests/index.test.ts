import { generateKeyPairSync } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import { type Env, handleRequest } from "../src/index";
import { seal } from "../src/session";

const privateKey = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { format: "pem", type: "pkcs1" },
  publicKeyEncoding: { format: "pem", type: "spki" },
}).privateKey;

const env: Env = {
  CONTROL_REPOSITORY: "actions-ext/copier-update",
  GITHUB_APP_ID: "123",
  GITHUB_APP_PRIVATE_KEY: privateKey,
  GITHUB_CLIENT_ID: "client-id",
  GITHUB_CLIENT_SECRET: "client-secret",
  PUBLIC_URL: "https://copier-update.example.workers.dev/",
  SESSION_SECRET: "session-secret",
};

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

async function authenticatedRequest(scope = "selected"): Promise<Request> {
  const session = await seal({ csrf: "csrf", expires: Date.now() + 60_000, token: "user-token" }, env.SESSION_SECRET);
  const body = new URLSearchParams({ csrf: "csrf", installation_id: "7", repository: "example/private", scope });
  return new Request(`${env.PUBLIC_URL}run`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: `copier_session=${session}` },
    body,
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("update requests", () => {
  it("verifies an organization owner and dispatches an installation-scoped request", async () => {
    const requests: Array<{ body: string | null; method: string; url: string }> = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = String(input);
      requests.push({ body: typeof init.body === "string" ? init.body : null, method: init.method || "GET", url });
      if (url.endsWith("/user")) return json({ login: "octocat" });
      if (url.includes("/user/installations?")) {
        return json({ installations: [{ id: 7, account: { login: "example", type: "Organization" } }] });
      }
      if (url.includes("/orgs/example/memberships/octocat")) return json({ role: "admin", state: "active" });
      if (url.includes("/user/installations/7/repositories")) {
        return json({ repositories: [{ full_name: "example/private", private: true }] });
      }
      if (url.endsWith("/repos/actions-ext/copier-update/installation")) return json({ id: 99 });
      if (url.endsWith("/app/installations/99/access_tokens")) return json({ token: "control-token" });
      if (url.endsWith("/repos/actions-ext/copier-update/dispatches")) return new Response(null, { status: 204 });
      return json({ message: "Not Found" }, 404);
    });

    const response = await handleRequest(await authenticatedRequest(), env);

    expect(response.status).toBe(202);
    const dispatch = requests.find((request) => request.url.endsWith("/dispatches"));
    expect(dispatch?.method).toBe("POST");
    expect(JSON.parse(dispatch?.body || "{}")).toMatchObject({
      client_payload: {
        owner: "example",
        repositories: ["example/private"],
        requester: "octocat",
        scope: "selected",
      },
      event_type: "copier-update",
    });
  });

  it("rejects organization members who are not owners", async () => {
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/user")) return json({ login: "octocat" });
      if (url.includes("/user/installations?")) {
        return json({ installations: [{ id: 7, account: { login: "example", type: "Organization" } }] });
      }
      if (url.includes("/orgs/example/memberships/octocat")) return json({ role: "member", state: "active" });
      return json({ message: "unexpected" }, 500);
    });

    const response = await handleRequest(await authenticatedRequest("all"), env);

    expect(response.status).toBe(403);
    expect(await response.text()).toContain("Only an active organization owner");
  });
});

describe("sessions", () => {
  it("requires the session CSRF token to sign out", async () => {
    const activeSession = await seal(
      { csrf: "csrf", expires: Date.now() + 60_000, token: "user-token" },
      env.SESSION_SECRET,
    );
    const response = await handleRequest(
      new Request(`${env.PUBLIC_URL}logout`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: `copier_session=${activeSession}` },
        body: new URLSearchParams({ csrf: "incorrect" }),
      }),
      env,
    );

    expect(response.status).toBe(403);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
});
