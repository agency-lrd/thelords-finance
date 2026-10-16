"use client"

import { useSyncExternalStore } from "react"

import { useI18n } from "@/lib/i18n/client"

/** Date line and greeting in the viewer's own time zone. */
export function Greeting({ name }: { name: string }) {
  const { t, locale } = useI18n()
  // Client clock (minute precision keeps the snapshot stable); null while server-rendering.
  const minute = useSyncExternalStore(
    () => () => {},
    () => Math.floor(Date.now() / 60_000),
    () => null,
  )
  const now = minute === null ? null : new Date(minute * 60_000)
  const hour = now?.getHours() ?? 12
  const greeting = hour < 5 ? t.greeting.night : hour < 12 ? t.greeting.morning : hour < 18 ? t.greeting.day : hour < 23 ? t.greeting.evening : t.greeting.night
  const date = now?.toLocaleDateString(locale === "ru" ? "ru-RU" : "en-US", { weekday: "long", day: "numeric", month: "long" }) ?? " "
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm font-semibold uppercase tracking-[0.22em] text-primary">{date}</p>
      <h1 className="font-display text-4xl leading-none font-black uppercase italic tracking-tight sm:text-6xl">
        {greeting}, {name}
      </h1>
    </div>
  )
}
