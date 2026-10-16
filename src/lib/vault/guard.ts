/**
 * Secret guard for the credential register. The register stores metadata only; this refuses text that
 * looks like a secret so passwords, keys or seed phrases do not end up in notes, usernames or URLs by
 * accident. Pure; used on the server before saving and in the form for an early warning.
 */

const PATTERNS: { reason: string; test: RegExp }[] = [
  { reason: "password", test: /(?<![\p{L}\p{N}])(pass(word)?|pwd|пароль|парол[ья]|secret|секрет)\s*[:=]\s*\S+/iu },
  { reason: "private key", test: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { reason: "API key", test: /\b(sk-(live|test|proj)?[-_]?[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|xox[abpr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,})\b/ },
  { reason: "token", test: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { reason: "crypto private key", test: /\b(0x)?[0-9a-fA-F]{64}\b/ },
  { reason: "recovery code", test: /(?<![\p{L}\p{N}])(recovery|backup|резервн\S*)\s*(codes?|коды?)\s*[:=]/iu },
  { reason: "credentials in URL", test: /^[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i },
]

/** Lowercase words (letters only) in a row of 12, 15, 18, 21 or 24: the shape of a seed phrase. */
function looksLikeSeedPhrase(text: string) {
  const words = text.trim().split(/\s+/)
  for (const n of [24, 21, 18, 15, 12]) {
    for (let i = 0; i + n <= words.length; i++) {
      const run = words.slice(i, i + n)
      if (run.every((w) => /^[a-z]{3,8}$/.test(w))) return true
    }
  }
  return false
}

/** Returns why the text looks like a secret, or null when it looks safe. */
export function secretReason(text: string | null | undefined): string | null {
  if (!text) return null
  for (const p of PATTERNS) if (p.test.test(text)) return p.reason
  if (looksLikeSeedPhrase(text)) return "seed phrase"
  return null
}

/**
 * Strong random password generated in the browser (Web Crypto). Never sent to the server: the user
 * copies it into the password manager. Guarantees at least one character from each enabled set.
 */
export function generatePassword(length = 24, sets = { lower: true, upper: true, digits: true, symbols: true }) {
  const pools = [
    sets.lower && "abcdefghijkmnopqrstuvwxyz",
    sets.upper && "ABCDEFGHJKLMNPQRSTUVWXYZ",
    sets.digits && "23456789",
    sets.symbols && "!@#$%^&*()-_=+[]{};:,.?",
  ].filter((p): p is string => !!p)
  if (pools.length === 0) throw new Error("Choose at least one character set")
  const size = Math.max(length, pools.length, 8)
  const all = pools.join("")
  const pick = (pool: string) => {
    // Rejection sampling for an unbiased index.
    const limit = 256 - (256 % pool.length)
    const buf = new Uint8Array(1)
    do crypto.getRandomValues(buf)
    while (buf[0] >= limit)
    return pool[buf[0] % pool.length]
  }
  const chars = [...pools.map(pick), ...Array.from({ length: size - pools.length }, () => pick(all))]
  // Fisher–Yates shuffle with crypto randomness.
  for (let i = chars.length - 1; i > 0; i--) {
    const buf = new Uint32Array(1)
    crypto.getRandomValues(buf)
    const j = buf[0] % (i + 1)
    ;[chars[i], chars[j]] = [chars[j], chars[i]]
  }
  return chars.join("")
}
