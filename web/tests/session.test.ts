import { describe, expect, it } from "vitest";

import { seal, sha256, unseal } from "../src/session";

describe("encrypted sessions", () => {
  it("round trips data without exposing its contents", async () => {
    const sealed = await seal({ token: "secret-token" }, "session-secret");

    expect(sealed).not.toContain("secret-token");
    expect(await unseal(sealed, "session-secret")).toEqual({ token: "secret-token" });
    expect(await unseal(sealed, "wrong-secret")).toBeNull();
  });

  it("creates a PKCE-compatible SHA-256 challenge", async () => {
    expect(await sha256("verifier")).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});
