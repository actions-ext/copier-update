const encoder = new TextEncoder();
const decoder = new TextDecoder();

function encodeBase64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decodeBase64Url(value: string): Uint8Array {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

async function sessionKey(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(secret));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function seal(value: unknown, secret: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await sessionKey(secret),
    encoder.encode(JSON.stringify(value)),
  );
  const output = new Uint8Array(iv.byteLength + ciphertext.byteLength);
  output.set(iv);
  output.set(new Uint8Array(ciphertext), iv.byteLength);
  return encodeBase64Url(output);
}

export async function unseal<T>(value: string, secret: string): Promise<T | null> {
  try {
    const input = decodeBase64Url(value);
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: input.slice(0, 12) },
      await sessionKey(secret),
      input.slice(12),
    );
    return JSON.parse(decoder.decode(plaintext)) as T;
  } catch {
    return null;
  }
}

export function cookie(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie") || "";
  for (const item of header.split(";")) {
    const [key, ...parts] = item.trim().split("=");
    if (key === name) {
      return parts.join("=");
    }
  }
  return null;
}

export function setCookie(name: string, value: string, maxAge: number): string {
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

export function clearCookie(name: string): string {
  return setCookie(name, "", 0);
}

export function randomValue(bytes = 32): string {
  return encodeBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256(value: string): Promise<string> {
  return encodeBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))));
}
