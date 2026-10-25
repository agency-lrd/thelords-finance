"use client"

import { Plus } from "lucide-react"
import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"

import { MovementDialog, type MovementOptions } from "@/components/finance/movement-dialog"
import { Button } from "@/components/ui/button"
import type { Locale } from "@/lib/i18n/format"

/** Manual cash entry from Cash Flow: creates the SAME transaction the Transactions page shows (never a copy). */
export function RecordMovementButton({ locale, options, canPaySalary }: { locale: Locale; options: MovementOptions; canPaySalary: boolean }) {
  const router = useRouter()
  const [, startRefresh] = useTransition()
  const [open, setOpen] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)} disabled={options.accounts.length === 0}>
        <Plus /> {locale === "ru" ? "Записать движение денег" : "Record money movement"}
      </Button>
      {message && <span role="status" className="text-xs text-emerald-300">{message}</span>}
      {open && (
        <MovementDialog
          locale={locale}
          options={options}
          canPaySalary={canPaySalary}
          onClose={() => setOpen(false)}
          onSaved={(text) => {
            setOpen(false)
            setMessage(text)
            startRefresh(() => router.refresh())
          }}
        />
      )}
    </>
  )
}
