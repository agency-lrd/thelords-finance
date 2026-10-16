import "server-only"

import { cookies } from "next/headers"

import { dictionaries } from "./dictionaries"
import type { Locale } from "./format"

export const LOCALE_COOKIE = "lang"

/** Reads the language cookie (Russian by default). Request-time: call inside a Suspense boundary. */
export async function getLocale(): Promise<Locale> {
  const value = (await cookies()).get(LOCALE_COOKIE)?.value
  return value === "en" ? "en" : "ru"
}

export async function getDictionary() {
  const locale = await getLocale()
  return { locale, t: dictionaries[locale] }
}
