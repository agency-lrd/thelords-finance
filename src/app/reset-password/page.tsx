import type { Metadata } from "next"
import Link from "next/link"
import { Suspense } from "react"

import { AuthShell } from "@/components/auth/auth-shell"

import { ResetPasswordForm } from "./reset-form"

export const metadata: Metadata = { title: "Новый пароль" }

export default function ResetPasswordPage() {
  return (
    <AuthShell
      title="Новый пароль"
      footer={<p className="mt-6 text-center text-sm"><Link href="/login" className="text-primary hover:underline">← Вернуться ко входу</Link></p>}
    >
      {/* Reads the link's state in the browser (URL fragment, error code, recovery session). */}
      <Suspense>
        <ResetPasswordForm />
      </Suspense>
    </AuthShell>
  )
}
