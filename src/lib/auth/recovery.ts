/**
 * Password recovery helpers shared by the server (forgot-password action, auth callback, proxy) and the
 * browser (reset page). Pure: no secrets, no I/O. Recovery tokens are never logged or put in messages.
 */

/** Origins the app may send people back to in emails. Anything else falls back to the main domain. */
export const PRODUCTION_ORIGIN = "https://www.osfnclrd.com"
const ALLOWED_HOSTS = ["www.osfnclrd.com", "osfnclrd.com", "thelords-finance.vercel.app", "localhost", "127.0.0.1"]

/** The public origin for links in emails, from the request host when it is one of ours. */
export function siteOrigin(host: string | null | undefined, proto: string | null | undefined) {
  const clean = (host ?? "").split(",")[0].trim().toLowerCase()
  const name = clean.replace(/:\d+$/, "")
  if (!ALLOWED_HOSTS.includes(name)) return PRODUCTION_ORIGIN
  const local = name === "localhost" || name === "127.0.0.1"
  const scheme = local ? (proto?.split(",")[0].trim() === "https" ? "https" : "http") : "https"
  return `${scheme}://${clean}`
}

/** Only same-site relative paths are accepted as destinations after a link. */
export function safeNext(value: string | null | undefined, fallback = "/") {
  return value && value.startsWith("/") && !value.startsWith("//") && !value.startsWith("/\\") ? value : fallback
}

export const RESET_PATH = "/reset-password"

export type RecoveryError = "expired" | "invalid" | "same_password" | "weak_password" | "rate_limit" | "no_session" | "mismatch" | "too_short" | "unknown"

export const RECOVERY_MESSAGES: Record<RecoveryError, string> = {
  expired: "Ссылка для восстановления пароля устарела или уже была использована. Запросите новую ссылку — она действует ограниченное время и только один раз.",
  invalid: "Ссылка для восстановления недействительна. Откройте самую последнюю ссылку из письма или запросите новую.",
  same_password: "Новый пароль совпадает с текущим. Придумайте другой пароль.",
  weak_password: "Пароль слишком простой. Используйте не меньше 12 символов: буквы, цифры и символы.",
  rate_limit: "Слишком много запросов. Подождите минуту и попробуйте снова.",
  no_session: "Сессия восстановления не найдена или истекла. Откройте ссылку из письма ещё раз или запросите новую.",
  mismatch: "Пароли не совпадают.",
  too_short: "Пароль должен быть не короче 12 символов.",
  unknown: "Не удалось выполнить действие. Попробуйте ещё раз или запросите новую ссылку.",
}

/** Maps a Supabase Auth error (code or message) to one of the recovery messages. */
export function recoveryError(code: string | null | undefined, message?: string | null): RecoveryError {
  const c = `${code ?? ""} ${message ?? ""}`.toLowerCase()
  if (/otp_expired|expired|flow_state_expired/.test(c)) return "expired"
  if (/same_password|should be different/.test(c)) return "same_password"
  if (/weak_password|password should|at least/.test(c)) return "weak_password"
  if (/rate|too many|429/.test(c)) return "rate_limit"
  if (/session_not_found|auth session missing|session missing|not logged in/.test(c)) return "no_session"
  if (/invalid|bad_code_verifier|code verifier|access_denied|otp/.test(c)) return "invalid"
  return "unknown"
}

/** Parses the fragment Supabase uses for implicit-flow links: tokens, type, or an error. */
export function parseAuthHash(hash: string) {
  const params = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash)
  return {
    accessToken: params.get("access_token"),
    refreshToken: params.get("refresh_token"),
    type: params.get("type"),
    error: params.get("error_code") ?? params.get("error"),
    errorDescription: params.get("error_description"),
  }
}
