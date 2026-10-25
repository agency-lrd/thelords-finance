import { connection } from "next/server"

import { prisma } from "@/lib/db"

/**
 * Health and latency probe: which region served the request and how long three trivial database round
 * trips took. Returns no data from the database. Used to measure performance after deployments.
 */
export async function GET() {
  await connection()
  const roundTrips: number[] = []
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now()
    await prisma.$queryRaw`SELECT 1`
    roundTrips.push(Math.round((performance.now() - t0) * 10) / 10)
  }
  return Response.json({ region: process.env.VERCEL_REGION ?? "local", dbRoundTripMs: roundTrips }, { headers: { "Cache-Control": "no-store" } })
}
