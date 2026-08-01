import { generateKeyPairSync } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createAppJwt } from "../src/github";

describe("GitHub App authentication", () => {
  it("signs a JWT with GitHub's PKCS#1 private-key format", async () => {
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { format: "pem", type: "pkcs1" },
      publicKeyEncoding: { format: "pem", type: "spki" },
    });

    const jwt = await createAppJwt("123", privateKey, 1_000);
    const [, payload] = jwt.split(".");
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString()) as Record<string, unknown>;

    expect(jwt.split(".")).toHaveLength(3);
    expect(claims).toEqual({ exp: 1_540, iat: 940, iss: "123" });
  });
});
