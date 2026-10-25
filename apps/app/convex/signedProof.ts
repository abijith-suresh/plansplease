export type SignedProof = Readonly<{
  expiresAt: number;
  signature: string;
}>;

const lifetimeMs = 60_000;
const maxClockSkewMs = 30_000;
const encoder = new TextEncoder();

const importKey = (secret: string) =>
  crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);

export async function signProof(secret: string, message: (expiresAt: number) => string) {
  const expiresAt = Date.now() + lifetimeMs;
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", await importKey(secret), encoder.encode(message(expiresAt)))
  );
  return {
    expiresAt,
    signature: Array.from(signature, (byte) => byte.toString(16).padStart(2, "0")).join(""),
  };
}

export async function verifyProof(
  secret: string,
  proof: SignedProof,
  message: string,
  now = Date.now()
) {
  if (
    !Number.isSafeInteger(proof.expiresAt) ||
    proof.expiresAt < now ||
    proof.expiresAt > now + lifetimeMs + maxClockSkewMs ||
    !/^[a-f0-9]{64}$/.test(proof.signature)
  ) {
    return false;
  }
  const signature = Uint8Array.from(proof.signature.match(/.{2}/g) ?? [], (part) =>
    Number.parseInt(part, 16)
  );
  return crypto.subtle.verify("HMAC", await importKey(secret), signature, encoder.encode(message));
}
