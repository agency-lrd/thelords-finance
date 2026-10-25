import "server-only"

import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto"

/**
 * Encryption for stored passwords (AES-256-GCM from Node's crypto module).
 *
 * Keys live only in the server environment, in VAULT_ENCRYPTION_KEYS: a comma-separated list of
 * "id:base64key" (32-byte keys), the FIRST being the active key used for new encryptions. Older keys stay
 * listed until every secret is re-encrypted ("rotate"), so rotation never loses data. The key is separate
 * from WALLET_ENCRYPTION_KEY and every other application key. Without it the vault is disabled; there is
 * no plaintext fallback.
 *
 * Each ciphertext is bound to its organization and credential (additional authenticated data), so a
 * ciphertext copied onto another row fails to decrypt instead of revealing a password elsewhere.
 * Format: version (1 byte) | iv (12) | auth tag (16) | ciphertext.
 */
const VERSION = 1

type Key = { id: string; key: Buffer }

function keys(): Key[] {
  const raw = process.env.VAULT_ENCRYPTION_KEYS?.trim()
  if (!raw) return []
  return raw.split(",").map((part) => {
    const [id, value] = part.trim().split(":")
    if (!id || !value || !/^[A-Za-z0-9_-]{1,40}$/.test(id)) throw new Error("VAULT_ENCRYPTION_KEYS: use id:base64key entries separated by commas.")
    const key = Buffer.from(value, "base64")
    if (key.length !== 32) throw new Error(`VAULT_ENCRYPTION_KEYS: key "${id}" must be 32 bytes, base64-encoded.`)
    return { id, key }
  })
}

export function vaultConfigured() {
  try {
    return keys().length > 0
  } catch {
    return false
  }
}

export function activeKeyId() {
  return keys()[0]?.id ?? null
}

function keyById(id: string) {
  const key = keys().find((k) => k.id === id)
  if (!key) throw new Error(`Vault key "${id}" is not configured. Keep old keys in VAULT_ENCRYPTION_KEYS until rotation is complete.`)
  return key.key
}

export function encryptVaultSecret(plain: string, aad: string): { keyId: string; data: Uint8Array<ArrayBuffer> } {
  const active = keys()[0]
  if (!active) throw new Error("VAULT_ENCRYPTION_KEYS is not set.")
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", active.key, iv)
  cipher.setAAD(Buffer.from(aad, "utf8"))
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()])
  const out = new Uint8Array(new ArrayBuffer(1 + 12 + 16 + ciphertext.length))
  out.set([VERSION], 0)
  out.set(iv, 1)
  out.set(cipher.getAuthTag(), 13)
  out.set(ciphertext, 29)
  return { keyId: active.id, data: out }
}

export function decryptVaultSecret(data: Uint8Array, keyId: string, aad: string): string {
  const buffer = Buffer.from(data)
  if (buffer[0] !== VERSION) throw new Error("Unknown vault encryption version")
  const decipher = createDecipheriv("aes-256-gcm", keyById(keyId), buffer.subarray(1, 13))
  decipher.setAAD(Buffer.from(aad, "utf8"))
  decipher.setAuthTag(buffer.subarray(13, 29))
  return Buffer.concat([decipher.update(buffer.subarray(29)), decipher.final()]).toString("utf8")
}

export const secretAad = (organizationId: string, credentialId: string) => `vault:${organizationId}:${credentialId}`

// ─────────────────────────────────────────────────────────────────────────────
// Fresh authentication: a short-lived signed "unlock" token after re-entering the password
// ─────────────────────────────────────────────────────────────────────────────

export const UNLOCK_COOKIE = "vault_unlock"
export const UNLOCK_SECONDS = 10 * 60

function unlockKey() {
  const active = keys()[0]
  if (!active) throw new Error("VAULT_ENCRYPTION_KEYS is not set.")
  return Buffer.from(hkdfSync("sha256", active.key, "thelords-vault", "unlock-token-v1", 32))
}

const sign = (userId: string, expires: number) => createHmac("sha256", unlockKey()).update(`${userId}.${expires}`).digest("base64url")

export function issueUnlockToken(userId: string, now = Date.now()) {
  const expires = now + UNLOCK_SECONDS * 1000
  return `${expires}.${sign(userId, expires)}`
}

export function verifyUnlockToken(token: string | undefined | null, userId: string, now = Date.now()) {
  if (!token || !vaultConfigured()) return false
  const [expiresRaw, mac] = token.split(".")
  const expires = Number(expiresRaw)
  if (!Number.isFinite(expires) || expires < now || expires > now + UNLOCK_SECONDS * 1000 + 5000 || !mac) return false
  const expected = Buffer.from(sign(userId, expires))
  const given = Buffer.from(mac)
  return expected.length === given.length && timingSafeEqual(expected, given)
}
