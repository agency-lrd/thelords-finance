import { NextResponse, type NextRequest } from "next/server"

import { getSession } from "@/lib/auth/session"
import { createImportBatch } from "@/lib/data/imports"
import { UserInputError } from "@/lib/forms"
import { LIMITS } from "@/lib/imports/fields"
import { ImportFileError } from "@/lib/imports/parse"

/*
 * Upload step of the transaction import: reads the file on the server (CSV or XLSX, size-limited) and
 * stores its cells in an import batch. Nothing is written to transactions here.
 */

export const maxDuration = 60

const json = (status: number, body: object) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } })

function sameOrigin(origin: string | null, host: string) {
  if (!origin) return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

export async function POST(request: NextRequest) {
  if (!sameOrigin(request.headers.get("origin"), request.nextUrl.host)) return json(403, { error: "forbidden" })
  const session = await getSession()
  if (session.state !== "ok") return json(401, { error: "unauthorized" })
  if (!session.user.permissions.has("journal:create")) return json(403, { error: "forbidden" })
  const length = Number(request.headers.get("content-length") ?? 0)
  if (length > LIMITS.maxBytes + 100_000) return json(413, { error: "too_large" })

  let form: FormData
  try {
    form = await request.formData()
  } catch {
    return json(400, { error: "invalid_request" })
  }
  const file = form.get("file")
  if (!(file instanceof File)) return json(400, { error: "no_file" })
  if (file.size > LIMITS.maxBytes) return json(413, { error: "too_large" })
  const text = (k: string) => (typeof form.get(k) === "string" ? (form.get(k) as string) : null)
  try {
    const result = await createImportBatch(session.user, { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) }, { delimiter: text("delimiter"), encoding: text("encoding") })
    return json(200, result)
  } catch (e) {
    if (e instanceof ImportFileError) return json(422, { error: e.code })
    if (e instanceof UserInputError) return json(403, { error: "forbidden" })
    console.error("Transaction import: upload failed", e instanceof Error ? e.message : e)
    return json(500, { error: "internal" })
  }
}
