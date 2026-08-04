const encoder = new TextEncoder();

function hex(value: ArrayBuffer): string {
  return [...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(left: string, right: string): boolean {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

export async function verifyWebhook(body: string, signature: string | null, secret: string): Promise<boolean> {
  if (!signature?.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  return constantTimeEqual(signature, `sha256=${hex(digest)}`);
}
