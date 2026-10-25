/** The sign-in pages' frame: brand, glow and card (black and magenta). */
export function AuthShell({ title, children, footer }: { title?: string; children: React.ReactNode; footer?: React.ReactNode }) {
  return (
    <main className="relative flex min-h-dvh items-center justify-center overflow-hidden px-4">
      <div aria-hidden className="pointer-events-none absolute -top-40 left-1/2 size-[36rem] -translate-x-1/2 rounded-full bg-primary/15 blur-3xl" />
      <div className="relative w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-4 text-center">
          <div>
            <h1 className="font-display text-4xl font-black text-primary italic drop-shadow-[0_0_24px_rgba(236,72,153,0.5)]">THE LORDS</h1>
            <p className="mt-2 font-display text-sm font-extrabold tracking-[0.2em] italic">FINANCE OS</p>
          </div>
        </div>
        <div className="rounded-2xl bg-card/80 p-6 ring-1 ring-foreground/10 backdrop-blur">
          {title && <h2 className="mb-4 font-display text-lg font-black uppercase">{title}</h2>}
          {children}
        </div>
        {footer}
      </div>
    </main>
  )
}
