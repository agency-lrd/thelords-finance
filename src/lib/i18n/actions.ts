"use server"

import { cookies } from "next/headers"

export async function setLocale(locale: "ru" | "en") {
  ;(await cookies()).set("lang", locale === "en" ? "en" : "ru", { path: "/", maxAge: 60 * 60 * 24 * 365, sameSite: "lax" })
}
