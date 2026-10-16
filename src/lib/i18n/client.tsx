"use client"

import { createContext, useContext } from "react"

import { dictionaries, type Dictionary } from "./dictionaries"
import type { Locale } from "./format"

const LocaleContext = createContext<{ locale: Locale; t: Dictionary }>({ locale: "ru", t: dictionaries.ru })

export function LocaleProvider({ locale, children }: { locale: Locale; children: React.ReactNode }) {
  return <LocaleContext.Provider value={{ locale, t: dictionaries[locale] as Dictionary }}>{children}</LocaleContext.Provider>
}

export function useI18n() {
  return useContext(LocaleContext)
}
