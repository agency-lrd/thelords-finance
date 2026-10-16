import Link from "next/link"

/** THE LORDS wordmark in the ecosystem style: magenta display type plus the product name. */
export function Brand() {
  return (
    <Link href="/" className="flex shrink-0 items-baseline gap-2.5 whitespace-nowrap outline-none" aria-label="THE LORDS Finance OS">
      <span className="font-display text-xl font-black tracking-tight text-primary italic drop-shadow-[0_0_18px_rgba(236,72,153,0.45)]">THE LORDS</span>
      <span className="hidden font-display text-sm font-extrabold tracking-wide text-foreground italic sm:inline">FINANCE OS</span>
    </Link>
  )
}
