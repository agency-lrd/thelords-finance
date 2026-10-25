"use client"

import { Copy, Eye, EyeOff, KeyRound, Loader2, Lock, Trash2 } from "lucide-react"
import { useEffect, useRef, useState } from "react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/form-controls"
import type { Locale } from "@/lib/i18n/format"

import { deleteSecretAction, revealSecretAction, setSecretAction, unlockVaultAction } from "./actions"

const T = {
  ru: {
    title: "Пароль (зашифрован в CRM)",
    none: "Пароль не сохранён.",
    stored: "Пароль сохранён в зашифрованном виде.",
    show: "Показать",
    hide: "Скрыть",
    copy: "Копировать",
    copied: "Скопировано — буфер очистится через 30 секунд",
    set: "Сохранить пароль",
    change: "Изменить пароль",
    remove: "Удалить пароль",
    removeConfirm: "Удалить сохранённый пароль? Это действие попадёт в журнал.",
    newPassword: "Новый пароль",
    save: "Сохранить",
    cancel: "Отмена",
    unlockTitle: "Подтвердите вход",
    unlockHint: "Чтобы показать или скопировать пароль, введите пароль своей учётной записи. Подтверждение действует 10 минут.",
    yourPassword: "Ваш пароль от CRM",
    confirm: "Подтвердить",
    notConfigured: "Хранение паролей не настроено: на сервере нет ключа шифрования VAULT_ENCRYPTION_KEYS. Небезопасная замена не используется.",
    onlySuper: "Сохранённые пароли доступны только Super Admin.",
    autoHide: "Скроется автоматически через 30 секунд.",
  },
  en: {
    title: "Password (encrypted in the CRM)",
    none: "No password stored.",
    stored: "The password is stored encrypted.",
    show: "Show",
    hide: "Hide",
    copy: "Copy",
    copied: "Copied: the clipboard is cleared in 30 seconds",
    set: "Store password",
    change: "Change password",
    remove: "Delete password",
    removeConfirm: "Delete the stored password? This is written to the audit log.",
    newPassword: "New password",
    save: "Save",
    cancel: "Cancel",
    unlockTitle: "Confirm it's you",
    unlockHint: "To show or copy a password, enter your account password. The confirmation lasts 10 minutes.",
    yourPassword: "Your CRM password",
    confirm: "Confirm",
    notConfigured: "Password storage is not configured: the server has no VAULT_ENCRYPTION_KEYS. No insecure fallback is used.",
    onlySuper: "Stored passwords are available to the Super Admin only.",
    autoHide: "Hidden automatically in 30 seconds.",
  },
}

/** Stored password of one credential: set/change/delete, and reveal/copy after a fresh password check. */
export function StoredPassword(props: { locale: Locale; credentialId: string; configured: boolean; superAdmin: boolean; hasSecret: boolean; archived: boolean; onChanged: () => void }) {
  const t = T[props.locale]
  const [revealed, setRevealed] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState("")
  const [showValue, setShowValue] = useState(false)
  const [unlock, setUnlock] = useState<null | "view" | "copy">(null)
  const [own, setOwn] = useState("")
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Never keep a revealed password around: it hides after 30 s, and the panel is remounted per entry.
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  if (!props.configured) return <p className="flex items-center gap-2 text-xs text-amber-300"><Lock className="size-3.5" /> {t.notConfigured}</p>
  if (!props.superAdmin) return <p className="flex items-center gap-2 text-xs text-muted-foreground"><Lock className="size-3.5" /> {t.onlySuper}</p>

  async function reveal(purpose: "view" | "copy") {
    setBusy(true)
    setError(null)
    const r = await revealSecretAction(props.credentialId, purpose)
    setBusy(false)
    if (!r.ok) {
      if ("needsUnlock" in r && r.needsUnlock) return setUnlock(purpose)
      return setError(r.message)
    }
    if (purpose === "copy") {
      await navigator.clipboard.writeText(r.secret)
      setNote(t.copied)
      setTimeout(() => {
        // Best effort: only clears if the clipboard still holds this password.
        navigator.clipboard.readText().then((current) => (current === r.secret ? navigator.clipboard.writeText("") : undefined)).catch(() => undefined)
        setNote(null)
      }, 30_000)
    } else {
      setRevealed(r.secret)
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => setRevealed(null), 30_000)
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <span className="flex items-center gap-2 text-sm text-muted-foreground"><KeyRound className="size-3.5" /> {props.hasSecret ? t.stored : t.none}</span>
      {props.hasSecret && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="min-w-40 rounded-lg border border-border bg-black/30 px-2 py-1 font-mono text-[13px]" aria-live="polite">{revealed ?? "••••••••••••"}</span>
          {revealed ? (
            <Button size="sm" variant="ghost" onClick={() => setRevealed(null)}><EyeOff /> {t.hide}</Button>
          ) : (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => reveal("view")}>{busy ? <Loader2 className="animate-spin" /> : <Eye />} {t.show}</Button>
          )}
          <Button size="sm" variant="outline" disabled={busy} onClick={() => reveal("copy")}><Copy /> {t.copy}</Button>
        </div>
      )}
      {revealed && <span className="text-[10px] text-muted-foreground">{t.autoHide}</span>}
      {note && <span className="text-[11px] text-primary">{note}</span>}
      {!props.archived && !editing && (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>{props.hasSecret ? t.change : t.set}</Button>
          {props.hasSecret && (
            <Button size="sm" variant="ghost" onClick={async () => {
              if (!window.confirm(t.removeConfirm)) return
              const r = await deleteSecretAction(props.credentialId)
              if (!r.ok) return setError(r.message)
              setRevealed(null)
              props.onChanged()
            }}><Trash2 /> {t.remove}</Button>
          )}
        </div>
      )}
      {editing && (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={async (e) => {
            e.preventDefault()
            setBusy(true)
            const r = await setSecretAction(props.credentialId, value)
            setBusy(false)
            if (!r.ok) return setError(r.message)
            setValue("")
            setEditing(false)
            props.onChanged()
          }}
        >
          <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
            {t.newPassword}
            <span className="flex items-center gap-1">
              <Input type={showValue ? "text" : "password"} autoComplete="new-password" value={value} onChange={(e) => setValue(e.target.value)} maxLength={4000} className="h-8 w-56 font-mono" />
              <button type="button" onClick={() => setShowValue((v) => !v)} className="text-muted-foreground hover:text-primary" aria-label={showValue ? t.hide : t.show}>{showValue ? <EyeOff className="size-4" /> : <Eye className="size-4" />}</button>
            </span>
          </label>
          <Button size="sm" type="submit" disabled={busy || !value}>{busy && <Loader2 className="animate-spin" />} {t.save}</Button>
          <Button size="sm" type="button" variant="ghost" onClick={() => { setEditing(false); setValue("") }}>{t.cancel}</Button>
        </form>
      )}
      {unlock && (
        <form
          className="flex flex-col gap-2 rounded-xl border border-primary/30 p-3"
          onSubmit={async (e) => {
            e.preventDefault()
            setBusy(true)
            const r = await unlockVaultAction(own)
            setBusy(false)
            setOwn("")
            if (!r.ok) return setError(r.message)
            const purpose = unlock
            setUnlock(null)
            await reveal(purpose)
          }}
        >
          <p className="text-xs font-semibold">{t.unlockTitle}</p>
          <p className="text-[11px] text-muted-foreground">{t.unlockHint}</p>
          <Input type="password" autoComplete="current-password" aria-label={t.yourPassword} placeholder={t.yourPassword} value={own} onChange={(e) => setOwn(e.target.value)} className="h-8" />
          <div className="flex gap-2">
            <Button size="sm" type="submit" disabled={busy || !own}>{busy && <Loader2 className="animate-spin" />} {t.confirm}</Button>
            <Button size="sm" type="button" variant="ghost" onClick={() => { setUnlock(null); setOwn("") }}>{t.cancel}</Button>
          </div>
        </form>
      )}
      {error && <p role="alert" className="text-xs text-red-300">{error}</p>}
    </div>
  )
}
