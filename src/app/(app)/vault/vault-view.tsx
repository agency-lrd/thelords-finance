"use client"

import { Archive, ArchiveRestore, Copy, ExternalLink, History, KeyRound, Lock, Plus, RefreshCw, Search, ShieldAlert, Users, Vault, X } from "lucide-react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useEffect, useMemo, useState, useTransition } from "react"
import { cn } from "cn"

import { Button } from "@/components/ui/button"
import { Input, Select, Textarea } from "@/components/ui/form-controls"
import type { listCredentials } from "@/lib/data/vault"
import { formatDate, type Locale } from "@/lib/i18n/format"
import { generatePassword, secretReason } from "@/lib/vault/guard"

import {
  archiveCredentialAction,
  createCategoryAction,
  historyAction,
  recordAccessAction,
  saveCredentialAction,
  shareAction,
  sharesAction,
  unshareAction,
  type CredentialForm,
} from "./actions"

type Row = Awaited<ReturnType<typeof listCredentials>>[number]

const T = {
  ru: {
    title: "Пароли",
    description: "Реестр доступов компании: сервис, логин, ответственный, кому открыт доступ. Сами пароли хранятся только в менеджере паролей (Bitwarden или 1Password) — здесь их нет.",
    notice: "Пароли, резервные коды, API-ключи и сид-фразы в это поле не сохраняются: система отклонит такие данные. Сид-фразы и приватные ключи кошельков нельзя хранить ни здесь, ни в общем менеджере паролей.",
    add: "Новая запись",
    search: "Сервис, URL, логин…",
    all: "Все",
    noDepartment: "Без отдела",
    archived: "Архив",
    apply: "Показать",
    empty: "Записей нет",
    emptyShared: "С вами пока не поделились ни одной записью.",
    col: { name: "Сервис", username: "Логин", category: "Категория", level: "Уровень", responsible: "Ответственный", updated: "Обновлено", shared: "Доступ" },
    level: { STANDARD: "Обычный", SENSITIVE: "Чувствительный", CRITICAL: "Критичный" },
    levelHint: "Критичный: финансовые платформы, резервные коды, API-ключи — только в менеджере паролей, с 2FA.",
    provider: { BITWARDEN: "Bitwarden", ONEPASSWORD: "1Password", OTHER: "Другой" },
    field: {
      name: "Сервис / платформа",
      loginUrl: "URL входа",
      username: "Логин / email",
      password: "Пароль",
      department: "Отдел",
      category: "Категория",
      responsible: "Ответственный сотрудник",
      accessLevel: "Уровень доступа",
      provider: "Менеджер паролей",
      itemRef: "Ссылка на запись в менеджере",
      notes: "Заметки (без секретов)",
      created: "Создано",
      updated: "Обновлено",
    },
    passwordStored: "Хранится в менеджере паролей",
    openInVault: "Открыть запись",
    noVaultRef: "Ссылка на запись не указана",
    copyUsername: "Копировать логин",
    copied: "Скопировано",
    openLogin: "Открыть страницу входа",
    edit: "Изменить",
    save: "Сохранить",
    cancel: "Отмена",
    archive: "В архив",
    restore: "Вернуть",
    share: "Доступ",
    shareWith: "Открыть доступ",
    view: "Просмотр",
    editLevel: "Редактирование",
    revoke: "Закрыть доступ",
    explicitOnly: "Доступ выдаётся только явно, по записи. Принадлежность к отделу доступа не даёт.",
    history: "История доступа",
    actions: { create: "создал(а)", update: "изменил(а)", archive: "в архив", restore: "вернул(а)", view: "просмотрел(а)", copy_username: "скопировал(а) логин", open_login: "открыл(а) вход", share: "открыл(а) доступ", unshare: "закрыл(а) доступ" },
    generator: "Генератор паролей",
    generatorHint: "Создаётся в вашем браузере и никуда не отправляется. Скопируйте пароль в менеджер паролей.",
    length: "Длина",
    generate: "Сгенерировать",
    newCategory: "Новая категория",
    secretWarning: "Похоже на секрет",
    readOnly: "Только просмотр",
  },
  en: {
    title: "Password Vault",
    description: "The company access register: service, login, owner and who has access. The passwords themselves live only in the password manager (Bitwarden or 1Password), not here.",
    notice: "Passwords, recovery codes, API keys and seed phrases are not stored here: the system rejects them. Wallet seed phrases and private keys must never be stored here or in a shared password manager.",
    add: "New entry",
    search: "Service, URL, login…",
    all: "All",
    noDepartment: "No department",
    archived: "Archived",
    apply: "Show",
    empty: "No entries",
    emptyShared: "Nothing has been shared with you yet.",
    col: { name: "Service", username: "Login", category: "Category", level: "Level", responsible: "Responsible", updated: "Updated", shared: "Access" },
    level: { STANDARD: "Standard", SENSITIVE: "Sensitive", CRITICAL: "Critical" },
    levelHint: "Critical: financial platforms, recovery codes, API keys — only in the password manager, with 2FA.",
    provider: { BITWARDEN: "Bitwarden", ONEPASSWORD: "1Password", OTHER: "Other" },
    field: {
      name: "Service / platform",
      loginUrl: "Login URL",
      username: "Username / email",
      password: "Password",
      department: "Department",
      category: "Category",
      responsible: "Responsible employee",
      accessLevel: "Access level",
      provider: "Password manager",
      itemRef: "Link to the item in the manager",
      notes: "Notes (no secrets)",
      created: "Created",
      updated: "Updated",
    },
    passwordStored: "Stored in the password manager",
    openInVault: "Open item",
    noVaultRef: "No item link set",
    copyUsername: "Copy username",
    copied: "Copied",
    openLogin: "Open login page",
    edit: "Edit",
    save: "Save",
    cancel: "Cancel",
    archive: "Archive",
    restore: "Restore",
    share: "Access",
    shareWith: "Give access",
    view: "View",
    editLevel: "Edit",
    revoke: "Revoke",
    explicitOnly: "Access is granted explicitly, per entry. Department membership does not grant access.",
    history: "Access history",
    actions: { create: "created", update: "updated", archive: "archived", restore: "restored", view: "viewed", copy_username: "copied username", open_login: "opened login", share: "shared", unshare: "revoked" },
    generator: "Password generator",
    generatorHint: "Generated in your browser and never sent anywhere. Copy it into the password manager.",
    length: "Length",
    generate: "Generate",
    newCategory: "New category",
    secretWarning: "Looks like a secret",
    readOnly: "View only",
  },
}

const emptyForm = (): CredentialForm => ({ name: "", loginUrl: "", username: "", departmentId: "", categoryId: "", responsibleEmployeeId: "", accessLevel: "STANDARD", vaultProvider: "BITWARDEN", vaultItemRef: "", notes: "" })
const fromRow = (r: Row): CredentialForm => ({ name: r.name, loginUrl: r.loginUrl ?? "", username: r.username ?? "", departmentId: r.departmentId ?? "", categoryId: r.categoryId ?? "", responsibleEmployeeId: r.responsibleEmployeeId ?? "", accessLevel: r.accessLevel, vaultProvider: r.vaultProvider ?? "", vaultItemRef: r.vaultItemRef ?? "", notes: r.notes ?? "" })

const LEVEL_TONE = { STANDARD: "border-border text-muted-foreground", SENSITIVE: "border-amber-400/50 text-amber-300", CRITICAL: "border-red-400/60 text-red-300" }

export function VaultView(props: {
  locale: Locale
  rows: Row[]
  categories: { id: string; name: string }[]
  departments: { id: string; name: string }[]
  employees: { id: string; name: string }[]
  candidates: { id: string; label: string }[]
  filters: Record<"q" | "dept" | "cat" | "level" | "archived", string>
  perms: { manage: boolean; audit: boolean }
}) {
  const { locale, rows, perms } = props
  const t = T[locale]
  const router = useRouter()
  const [, start] = useTransition()
  const [selected, setSelected] = useState<Row | null>(null)
  const [editing, setEditing] = useState<{ id: string | null; form: CredentialForm } | null>(null)
  const [message, setMessage] = useState<{ text: string; tone: "ok" | "error" } | null>(null)
  const refresh = () => start(() => router.refresh())

  const groups = useMemo(() => {
    const map = new Map<string, Row[]>()
    for (const r of rows) {
      const key = r.department ?? t.noDepartment
      map.set(key, [...(map.get(key) ?? []), r])
    }
    // Deterministic order (same on server and browser): plain code-point order, "no department" last.
    return [...map.entries()].sort((a, b) => (a[0] === t.noDepartment ? 1 : b[0] === t.noDepartment ? -1 : a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  }, [rows, t])

  async function run(fn: () => Promise<{ ok: boolean; message?: string }>, success?: string) {
    const r = await fn()
    if (!r.ok) setMessage({ text: r.message ?? "Error", tone: "error" })
    else {
      if (success) setMessage({ text: success, tone: "ok" })
      refresh()
    }
    return r.ok
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="flex flex-col gap-2">
          <h1 className="flex items-center gap-3 font-display text-3xl font-black uppercase tracking-tight sm:text-4xl"><KeyRound className="size-7 text-primary" /> {t.title}</h1>
          <p className="max-w-3xl text-sm text-muted-foreground">{t.description}</p>
        </div>
        {perms.manage && <Button size="sm" onClick={() => setEditing({ id: null, form: emptyForm() })}><Plus /> {t.add}</Button>}
      </div>
      <p className="flex items-start gap-2 rounded-2xl border border-primary/30 bg-primary/5 px-4 py-3 text-xs text-foreground/80"><ShieldAlert className="mt-0.5 size-4 shrink-0 text-primary" /> {t.notice}</p>
      {message && <p role={message.tone === "error" ? "alert" : "status"} className={cn("rounded-xl border px-4 py-2 text-sm", message.tone === "error" ? "border-destructive/40 bg-destructive/10 text-red-200" : "border-primary/30 bg-primary/10")}>{message.text}</p>}

      <form method="get" className="flex flex-wrap items-center gap-2 rounded-2xl border border-border bg-card/30 p-3">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input name="q" defaultValue={props.filters.q} placeholder={t.search} className="h-8 w-64 pl-9" aria-label={t.search} />
        </div>
        <Select name="dept" defaultValue={props.filters.dept} className="h-8 w-48" aria-label={t.field.department}>
          <option value="">{t.field.department}: {t.all}</option>
          {props.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          <option value="none">{t.noDepartment}</option>
        </Select>
        <Select name="cat" defaultValue={props.filters.cat} className="h-8 w-48" aria-label={t.field.category}>
          <option value="">{t.field.category}: {t.all}</option>
          {props.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Select>
        <Select name="level" defaultValue={props.filters.level} className="h-8 w-44" aria-label={t.field.accessLevel}>
          <option value="">{t.field.accessLevel}: {t.all}</option>
          {(["STANDARD", "SENSITIVE", "CRITICAL"] as const).map((l) => <option key={l} value={l}>{t.level[l]}</option>)}
        </Select>
        <label className="flex items-center gap-2 px-2 text-xs text-muted-foreground"><input type="checkbox" name="archived" value="1" defaultChecked={props.filters.archived === "1"} className="accent-[var(--primary)]" /> {t.archived}</label>
        <Button type="submit" size="sm" variant="outline">{t.apply}</Button>
        <Link href="/vault" className="px-2 text-xs text-muted-foreground hover:text-foreground">×</Link>
      </form>

      <div className="grid gap-6 xl:grid-cols-[1fr_340px]">
        <div className="flex flex-col gap-5">
          {rows.length === 0 && (
            <div className="rounded-2xl border border-dashed border-border px-6 py-14 text-center">
              <p className="font-medium">{t.empty}</p>
              {!perms.manage && <p className="mt-1 text-sm text-muted-foreground">{t.emptyShared}</p>}
            </div>
          )}
          {groups.map(([department, list]) => (
            <section key={department} className="overflow-hidden rounded-2xl bg-card/50 ring-1 ring-foreground/10">
              <p className="border-b border-border/60 bg-white/[0.02] px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-primary">{department} · {list.length}</p>
              <table className="w-full text-[13px]">
                <thead className="text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
                  <tr>{[t.col.name, t.col.username, t.col.category, t.col.level, t.col.responsible, t.col.updated].map((h) => <th key={h} className="px-4 py-2 text-left font-medium">{h}</th>)}</tr>
                </thead>
                <tbody>
                  {list.map((r) => (
                    <tr key={r.id} onClick={() => { setSelected(r); void recordAccessAction(r.id, "view") }} className={cn("cursor-pointer border-t border-border/40 hover:bg-white/[0.03]", selected?.id === r.id && "bg-primary/10", r.archived && "text-muted-foreground")}>
                      <td className="px-4 py-2 font-medium">{r.name}</td>
                      <td className="max-w-56 truncate px-4 py-2 font-mono text-[12px] text-foreground/80">{r.username ?? "—"}</td>
                      <td className="px-4 py-2 text-muted-foreground">{r.category ?? "—"}</td>
                      <td className="px-4 py-2"><span className={cn("rounded-full border px-2 py-0.5 text-[11px]", LEVEL_TONE[r.accessLevel])}>{t.level[r.accessLevel]}</span></td>
                      <td className="px-4 py-2 text-muted-foreground">{r.responsible ?? "—"}</td>
                      <td className="px-4 py-2 whitespace-nowrap text-muted-foreground">{formatDate(r.updatedAt.slice(0, 10), locale)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ))}
        </div>
        <aside className="flex flex-col gap-4">
          {selected ? (
            <Detail key={selected.id} row={selected} t={t} locale={locale} perms={perms} candidates={props.candidates} onClose={() => setSelected(null)} onEdit={() => setEditing({ id: selected.id, form: fromRow(selected) })} run={run} />
          ) : (
            <Generator t={t} />
          )}
          {perms.manage && <NewCategory t={t} run={run} />}
        </aside>
      </div>

      {editing && (
        <EditDialog
          t={t}
          form={editing.form}
          isNew={!editing.id}
          categories={props.categories}
          departments={props.departments}
          employees={props.employees}
          onClose={() => setEditing(null)}
          onSave={async (form) => {
            if (await run(() => saveCredentialAction(editing.id, form))) {
              setEditing(null)
              setSelected(null)
            }
          }}
        />
      )}
    </div>
  )
}

type Texts = (typeof T)["ru"]

function Detail(props: {
  row: Row
  t: Texts
  locale: Locale
  perms: { manage: boolean; audit: boolean }
  candidates: { id: string; label: string }[]
  onClose: () => void
  onEdit: () => void
  run: (fn: () => Promise<{ ok: boolean; message?: string }>, success?: string) => Promise<boolean>
}) {
  const { row: r, t, perms } = props
  const [panel, setPanel] = useState<"none" | "share" | "history">("none")
  const [copied, setCopied] = useState(false)
  const vaultUrl = r.vaultItemRef && /^https?:\/\//i.test(r.vaultItemRef) ? r.vaultItemRef : null
  const field = (label: string, value: React.ReactNode) => (
    <div className="flex flex-col gap-0.5 border-t border-border/40 py-2 first:border-0">
      <span className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">{label}</span>
      <span className="text-sm break-words">{value}</span>
    </div>
  )
  return (
    <div className="flex flex-col gap-4 rounded-2xl border border-primary/30 bg-[#141015] p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-display text-lg font-black uppercase italic">{r.name}</p>
          <span className={cn("mt-1 inline-flex rounded-full border px-2 py-0.5 text-[11px]", LEVEL_TONE[r.accessLevel])}>{t.level[r.accessLevel]}</span>
          {!r.canEdit && <span className="ml-2 text-[11px] text-muted-foreground">{t.readOnly}</span>}
        </div>
        <button type="button" onClick={props.onClose} aria-label={t.cancel} className="text-muted-foreground hover:text-foreground"><X className="size-4" /></button>
      </div>
      <div>
        {field(t.field.loginUrl, r.loginUrl ? (
          <a href={r.loginUrl} target="_blank" rel="noopener noreferrer" onClick={() => void recordAccessAction(r.id, "open_login")} className="inline-flex items-center gap-1 text-primary hover:underline">{r.loginUrl} <ExternalLink className="size-3" /></a>
        ) : "—")}
        {field(t.field.username, r.username ? (
          <span className="flex items-center gap-2 font-mono text-[13px]">
            <span className="truncate">{r.username}</span>
            <button type="button" aria-label={t.copyUsername} title={t.copyUsername} className="text-muted-foreground hover:text-primary" onClick={async () => { await navigator.clipboard.writeText(r.username!); setCopied(true); void recordAccessAction(r.id, "copy_username"); setTimeout(() => setCopied(false), 1500) }}>
              <Copy className="size-3.5" />
            </button>
            {copied && <span className="text-[11px] text-primary">{t.copied}</span>}
          </span>
        ) : "—")}
        {field(t.field.password, (
          <span className="flex flex-col gap-1.5">
            <span className="flex items-center gap-2 text-muted-foreground"><Lock className="size-3.5" /> {t.passwordStored}{r.vaultProvider ? ` · ${t.provider[r.vaultProvider]}` : ""}</span>
            {vaultUrl ? <a href={vaultUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-sm text-primary hover:underline"><Vault className="size-3.5" /> {t.openInVault}</a> : <span className="text-xs text-muted-foreground">{r.vaultItemRef ?? t.noVaultRef}</span>}
          </span>
        ))}
        {field(t.field.category, r.category ?? "—")}
        {field(t.field.department, r.department ?? "—")}
        {field(t.field.responsible, r.responsible ?? "—")}
        {r.notes && field(t.field.notes, <span className="whitespace-pre-wrap text-foreground/85">{r.notes}</span>)}
        {field(`${t.field.created} / ${t.field.updated}`, `${formatDate(r.createdAt.slice(0, 10), props.locale)} / ${formatDate(r.updatedAt.slice(0, 10), props.locale)}`)}
      </div>
      <div className="flex flex-wrap gap-2">
        {r.canEdit && <Button size="sm" variant="outline" onClick={props.onEdit}>{t.edit}</Button>}
        {perms.manage && <Button size="sm" variant="outline" onClick={() => setPanel(panel === "share" ? "none" : "share")}><Users /> {t.share}{r.sharedWith !== null ? ` · ${r.sharedWith}` : ""}</Button>}
        {perms.audit && <Button size="sm" variant="outline" onClick={() => setPanel(panel === "history" ? "none" : "history")}><History /> {t.history}</Button>}
        {perms.manage && (
          <Button size="sm" variant="ghost" onClick={() => props.run(() => archiveCredentialAction(r.id, !r.archived)).then((ok) => ok && props.onClose())}>
            {r.archived ? <><ArchiveRestore /> {t.restore}</> : <><Archive /> {t.archive}</>}
          </Button>
        )}
      </div>
      {panel === "share" && <Sharing id={r.id} t={t} candidates={props.candidates} run={props.run} />}
      {panel === "history" && <HistoryList id={r.id} t={t} locale={props.locale} />}
    </div>
  )
}

function Sharing({ id, t, candidates, run }: { id: string; t: Texts; candidates: { id: string; label: string }[]; run: (fn: () => Promise<{ ok: boolean; message?: string }>) => Promise<boolean> }) {
  const [shares, setShares] = useState<{ id: string; userId: string; user: string; level: string }[] | null>(null)
  const [form, setForm] = useState({ userId: "", level: "VIEW" })
  const load = () => sharesAction(id).then((r) => r.ok && setShares(r.shares))
  useEffect(() => {
    sharesAction(id).then((r) => r.ok && setShares(r.shares))
  }, [id])
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-border/60 p-3 text-sm">
      <p className="text-[11px] text-muted-foreground">{t.explicitOnly}</p>
      {shares?.map((s) => (
        <div key={s.id} className="flex items-center justify-between gap-2">
          <span className="truncate">{s.user} <span className="text-xs text-muted-foreground">· {s.level === "EDIT" ? t.editLevel : t.view}</span></span>
          <button type="button" className="text-xs text-red-300 hover:underline" onClick={async () => (await run(() => unshareAction(s.id))) && load()}>{t.revoke}</button>
        </div>
      ))}
      <div className="flex flex-wrap gap-2 pt-1">
        <Select value={form.userId} onChange={(e) => setForm({ ...form, userId: e.target.value })} className="h-8 min-w-0 flex-1 text-xs" aria-label={t.shareWith}>
          <option value="">{t.shareWith}…</option>
          {candidates.filter((c) => !shares?.some((s) => s.userId === c.id)).map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
        </Select>
        <Select value={form.level} onChange={(e) => setForm({ ...form, level: e.target.value })} className="h-8 w-32 text-xs" aria-label="Level">
          <option value="VIEW">{t.view}</option>
          <option value="EDIT">{t.editLevel}</option>
        </Select>
        <Button size="sm" disabled={!form.userId} onClick={async () => { if (await run(() => shareAction(id, form.userId, form.level))) { setForm({ userId: "", level: "VIEW" }); void load() } }}>+</Button>
      </div>
    </div>
  )
}

function HistoryList({ id, t, locale }: { id: string; t: Texts; locale: Locale }) {
  const [items, setItems] = useState<{ at: string; action: string; actor: string }[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    historyAction(id).then((r) => (r.ok ? setItems(r.history) : setError(r.message)))
  }, [id])
  return (
    <div className="flex max-h-72 flex-col gap-1 overflow-y-auto rounded-xl border border-border/60 p-3 text-xs">
      {error && <p className="text-destructive">{error}</p>}
      {items?.map((h, i) => (
        <div key={i} className="flex justify-between gap-2 border-t border-border/30 py-1 first:border-0">
          <span className="truncate">{h.actor} <span className="text-muted-foreground">{t.actions[h.action as keyof Texts["actions"]] ?? h.action}</span></span>
          <span className="shrink-0 text-muted-foreground">{formatDate(h.at.slice(0, 10), locale)} {h.at.slice(11, 16)}</span>
        </div>
      ))}
    </div>
  )
}

function Generator({ t }: { t: Texts }) {
  const [length, setLength] = useState(24)
  const [value, setValue] = useState("")
  const [copied, setCopied] = useState(false)
  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-border bg-card/60 p-5">
      <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-primary"><RefreshCw className="size-3.5" /> {t.generator}</p>
      <p className="text-[11px] text-muted-foreground">{t.generatorHint}</p>
      <label className="flex items-center gap-3 text-xs text-muted-foreground">{t.length} <input type="range" min={12} max={64} value={length} onChange={(e) => setLength(Number(e.target.value))} className="flex-1 accent-[var(--primary)]" /> <span className="w-6 font-mono text-foreground">{length}</span></label>
      {value && (
        <div className="flex items-center gap-2 rounded-lg bg-black/40 px-3 py-2">
          <code className="min-w-0 flex-1 break-all font-mono text-[13px]" autoCorrect="off" spellCheck={false}>{value}</code>
          <button type="button" aria-label={t.copied} className="text-muted-foreground hover:text-primary" onClick={async () => { await navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1500) }}><Copy className="size-4" /></button>
        </div>
      )}
      {copied && <span className="text-[11px] text-primary">{t.copied}</span>}
      <Button size="sm" variant="outline" onClick={() => { setValue(generatePassword(length)); setCopied(false) }}>{t.generate}</Button>
    </div>
  )
}

function NewCategory({ t, run }: { t: Texts; run: (fn: () => Promise<{ ok: boolean; message?: string }>) => Promise<boolean> }) {
  const [name, setName] = useState("")
  return (
    <form className="flex gap-2" onSubmit={async (e) => { e.preventDefault(); if (await run(() => createCategoryAction(name))) setName("") }}>
      <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t.newCategory} maxLength={80} className="h-8" aria-label={t.newCategory} />
      <Button type="submit" size="sm" variant="outline" disabled={!name.trim()}><Plus /></Button>
    </form>
  )
}

function EditDialog(props: {
  t: Texts
  form: CredentialForm
  isNew: boolean
  categories: { id: string; name: string }[]
  departments: { id: string; name: string }[]
  employees: { id: string; name: string }[]
  onClose: () => void
  onSave: (form: CredentialForm) => Promise<void>
}) {
  const { t } = props
  const [form, setForm] = useState(props.form)
  const [saving, setSaving] = useState(false)
  const set = (k: keyof CredentialForm) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }))
  const warnings = (["notes", "username", "loginUrl", "vaultItemRef"] as const).map((k) => [k, secretReason(form[k])] as const).filter(([, r]) => r)
  const label = (text: string, node: React.ReactNode, span = false) => <label className={cn("flex flex-col gap-1.5 text-xs font-medium text-muted-foreground", span && "sm:col-span-2")}>{text}{node}</label>
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm" onMouseDown={props.onClose}>
      <div role="dialog" aria-modal="true" aria-label={t.add} className="max-h-[92dvh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-[#141015] p-6 shadow-2xl ring-1 ring-primary/25" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === "Escape" && props.onClose()}>
        <h2 className="mb-4 font-display text-lg font-bold uppercase">{props.isNew ? t.add : t.edit}</h2>
        <form
          className="grid gap-3 sm:grid-cols-2"
          // Browsers must not offer to save these fields as passwords.
          autoComplete="off"
          onSubmit={async (e) => {
            e.preventDefault()
            setSaving(true)
            await props.onSave(form)
            setSaving(false)
          }}
        >
          {label(t.field.name, <Input value={form.name} onChange={set("name")} required maxLength={160} autoFocus />)}
          {label(t.field.loginUrl, <Input value={form.loginUrl} onChange={set("loginUrl")} type="url" placeholder="https://" />)}
          {label(t.field.username, <Input value={form.username} onChange={set("username")} maxLength={200} autoComplete="off" />)}
          {label(t.field.category, <Select value={form.categoryId} onChange={set("categoryId")}><option value="">—</option>{props.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>)}
          {label(t.field.department, <Select value={form.departmentId} onChange={set("departmentId")}><option value="">—</option>{props.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</Select>)}
          {label(t.field.responsible, <Select value={form.responsibleEmployeeId} onChange={set("responsibleEmployeeId")}><option value="">—</option>{props.employees.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</Select>)}
          {label(t.field.accessLevel, <Select value={form.accessLevel} onChange={set("accessLevel")}>{(["STANDARD", "SENSITIVE", "CRITICAL"] as const).map((l) => <option key={l} value={l}>{t.level[l]}</option>)}</Select>)}
          {label(t.field.provider, <Select value={form.vaultProvider} onChange={set("vaultProvider")}><option value="">—</option>{(["BITWARDEN", "ONEPASSWORD", "OTHER"] as const).map((p) => <option key={p} value={p}>{t.provider[p]}</option>)}</Select>)}
          {label(t.field.itemRef, <Input value={form.vaultItemRef} onChange={set("vaultItemRef")} maxLength={500} placeholder="https://vault.bitwarden.com/#/vault?itemId=…" />, true)}
          {label(t.field.notes, <Textarea value={form.notes} onChange={set("notes")} maxLength={2000} />, true)}
          <p className="text-[11px] text-muted-foreground sm:col-span-2">{t.levelHint}</p>
          {warnings.length > 0 && (
            <p role="alert" className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-200 sm:col-span-2">
              {t.secretWarning}: {warnings.map(([k, r]) => `${t.field[k === "vaultItemRef" ? "itemRef" : k]} (${r})`).join(", ")}
            </p>
          )}
          <div className="flex justify-end gap-2 sm:col-span-2">
            <Button type="button" variant="ghost" onClick={props.onClose}>{t.cancel}</Button>
            <Button type="submit" disabled={saving || warnings.length > 0}>{t.save}</Button>
          </div>
        </form>
      </div>
    </div>
  )
}
