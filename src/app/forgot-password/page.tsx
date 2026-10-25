import type { Metadata } from "next"
import Link from "next/link"

import { AuthShell } from "@/components/auth/auth-shell"

import { ForgotPasswordForm } from "./forgot-form"

export const metadata: Metadata = { title: "Восстановление пароля" }

export default function ForgotPasswordPage() {
  return (
    <AuthShell
      title="Восстановление пароля"
      footer={<p className="mt-6 text-center text-sm"><Link href="/login" className="text-primary hover:underline">← Вернуться ко входу</Link></p>}
    >
      <ForgotPasswordForm />
    </AuthShell>
  )
}
