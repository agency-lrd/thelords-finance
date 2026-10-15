import Link from "next/link"

export default function NotFound() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-4 px-4 text-center">
      <p className="text-xs uppercase tracking-[0.2em] text-primary">404</p>
      <h1 className="text-2xl font-semibold">Page not found</h1>
      <Link href="/" className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
        Back to dashboard
      </Link>
    </div>
  )
}
