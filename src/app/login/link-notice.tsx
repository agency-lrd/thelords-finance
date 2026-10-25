"use client"

import { useEffect, useState } from "react"

import { parseAuthHash, RECOVERY_MESSAGES, recoveryError, RESET_PATH } from "@/lib/auth/recovery"

/**
 * Email links that land on the sign-in page (for example a recovery link to the Site URL, redirected
 * here because nobody is signed in yet): a recovery link continues to the "new password" page with its
 * fragment; a link error is explained in Russian.
 */
export function LinkNotice({ error, passwordUpdated }: { error: string | null; passwordUpdated: boolean }) {
  const [hashError, setHashError] = useState<string | null>(null)
  useEffect(() => {
    const hash = parseAuthHash(window.location.hash)
    if (hash.type === "recovery" || (hash.accessToken && hash.refreshToken)) {
      window.location.replace(`${RESET_PATH}${window.location.hash}`)
      return
    }
    if (hash.error) {
      window.history.replaceState(null, "", window.location.pathname + window.location.search)
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reads the URL fragment once, browser only
      setHashError(RECOVERY_MESSAGES[recoveryError(hash.error, hash.errorDescription)])
    }
  }, [])
  const text = hashError ?? (error ? (error in RECOVERY_MESSAGES ? RECOVERY_MESSAGES[error as keyof typeof RECOVERY_MESSAGES] : error === "confirm" ? RECOVERY_MESSAGES.invalid : null) : null)
  if (passwordUpdated) return <p role="status" className="mb-4 rounded-xl border border-emerald-400/40 bg-emerald-400/10 px-3 py-2 text-sm text-emerald-200">Пароль обновлён. Войдите с новым паролем.</p>
  if (!text) return null
  return <p role="alert" className="mb-4 rounded-xl border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-red-200">{text}</p>
}
