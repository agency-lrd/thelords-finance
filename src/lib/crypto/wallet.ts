import "server-only"

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"

/**
 * Wallet addresses and bank details are encrypted in the application (AES-256-GCM) before they reach
 * the database, with a key that lives only in the environment (WALLET_ENCRYPTION_KEY, 32 bytes,
 * base64). The database stores iv | auth tag | ciphertext plus a masked form for display.
 */
const VERSION = 1

function key() {
  const raw = process.env.WALLET_ENCRYPTION_KEY
  if (!raw) throw new Error("WALLET_ENCRYPTION_KEY is not set. Add it to the environment (see .env.example).")
  const buffer = Buffer.from(raw, "base64")
  if (buffer.length !== 32) throw new Error("WALLET_ENCRYPTION_KEY must be 32 bytes, base64-encoded.")
  return buffer
}

export function encryptSecret(plain: string): Uint8Array<ArrayBuffer> {
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", key(), iv)
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()])
  const out = new Uint8Array(new ArrayBuffer(1 + 12 + 16 + ciphertext.length))
  out.set([VERSION], 0)
  out.set(iv, 1)
  out.set(cipher.getAuthTag(), 13)
  out.set(ciphertext, 29)
  return out
}

export function decryptSecret(data: Uint8Array): string {
  const buffer = Buffer.from(data)
  if (buffer[0] !== VERSION) throw new Error("Unknown wallet encryption version")
  const decipher = createDecipheriv("aes-256-gcm", key(), buffer.subarray(1, 13))
  decipher.setAuthTag(buffer.subarray(13, 29))
  return Buffer.concat([decipher.update(buffer.subarray(29)), decipher.final()]).toString("utf8")
}

/** "TRvCuZ4f…FJ9nFKx3" style mask: enough to recognize an address, not enough to use it. */
export function maskIdentifier(value: string) {
  const clean = value.trim()
  if (clean.length <= 10) return `${clean.slice(0, 2)}••••${clean.slice(-2)}`
  return `${clean.slice(0, 6)}…${clean.slice(-4)}`
}

/** Best-effort network detection for common USDT addresses. */
export function detectNetwork(address: string) {
  if (/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address)) return "TRC20"
  if (/^0x[0-9a-fA-F]{40}$/.test(address)) return "ERC20"
  return null
}
