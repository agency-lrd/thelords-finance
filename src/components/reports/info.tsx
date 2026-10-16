"use client"

import { Info } from "lucide-react"

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

/** Small (i) icon with an explanation of a metric. */
export function InfoTip({ text }: { text: string }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<button type="button" aria-label={text} className="inline-flex align-middle text-muted-foreground/70 hover:text-primary" />}>
        <Info className="size-3.5" />
      </TooltipTrigger>
      <TooltipContent className="max-w-72 text-xs leading-relaxed">{text}</TooltipContent>
    </Tooltip>
  )
}
