/**
 * Runs the Prisma CLI against DIRECT_URL (Supabase session pooler) through a loopback TLS relay.
 *
 * The relay listens on 127.0.0.1 only and opens each upstream connection with Node TLS,
 * verifying the certificate chain and hostname against the pinned Supabase root CA.
 * Verification failures close the connection; there is no fallback to unverified TLS.
 *
 * Usage: npm run db:prisma -- <prisma args>   e.g.  npm run db:prisma -- migrate status
 * Connection strings and the database password are never printed; CLI output is redacted.
 */
import { spawn } from "node:child_process"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import net from "node:net"
import tls from "node:tls"

import { config } from "dotenv"

import { SUPABASE_ROOT_CA } from "../src/lib/db-ssl"

config({ path: ".env.local", quiet: true })

const SSL_REQUEST_CODE = 80877103
const CA_FILE = "prisma/certs/supabase-root-2021-ca.crt"
const HANDSHAKE_TIMEOUT_MS = 15_000
const TLS_PARAMS = ["sslmode", "sslaccept", "sslcert", "sslidentity", "sslpassword", "sslrootcert"]

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

function sslRequest() {
  const buf = Buffer.alloc(8)
  buf.writeInt32BE(8, 0)
  buf.writeInt32BE(SSL_REQUEST_CODE, 4)
  return buf
}

/** Connects to Postgres, negotiates TLS and resolves once the server certificate is verified. */
function connectVerified(host: string, port: number): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const raw = net.connect(port, host, () => raw.write(sslRequest()))
    raw.setTimeout(HANDSHAKE_TIMEOUT_MS, () => raw.destroy(new Error("TLS handshake timed out")))
    raw.once("error", reject)
    raw.once("data", (reply) => {
      if (reply.length !== 1 || reply[0] !== 0x53 /* 'S' */) {
        raw.destroy()
        reject(new Error("Server refused TLS"))
        return
      }
      const secure = tls.connect({
        socket: raw,
        servername: host,
        ca: SUPABASE_ROOT_CA.trim(),
        rejectUnauthorized: true,
      })
      secure.once("error", reject)
      secure.once("secureConnect", () => {
        raw.setTimeout(0)
        resolve(secure)
      })
    })
  })
}

function startRelay(host: string, port: number): Promise<net.Server> {
  const server = net.createServer({ pauseOnConnect: true }, (client) => {
    client.on("error", () => client.destroy())
    connectVerified(host, port).then(
      (upstream) => {
        if (client.destroyed) return upstream.destroy()
        upstream.on("error", () => client.destroy())
        upstream.on("close", () => client.destroy())
        client.on("close", () => upstream.destroy())
        client.pipe(upstream).pipe(client)
        client.resume()
      },
      (error: Error) => {
        console.error(`TLS relay: upstream connection rejected (${error.message})`)
        client.destroy()
      },
    )
  })

  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => resolve(server))
  })
}

/** Line-buffered redaction so a secret split across chunks is still caught. */
function redactingWriter(out: NodeJS.WriteStream, secrets: string[]) {
  const redact = (text: string) => {
    let result = text.replace(/postgres(ql)?:\/\/[^\s"'`]+/gi, "postgresql://[redacted]")
    for (const secret of secrets) result = result.split(secret).join("[redacted]")
    return result
  }
  let pending = ""
  let timer: NodeJS.Timeout | undefined
  const flush = () => {
    if (pending) out.write(redact(pending))
    pending = ""
  }
  return {
    write(chunk: Buffer) {
      pending += chunk.toString()
      const cut = pending.lastIndexOf("\n") + 1
      if (cut > 0) {
        out.write(redact(pending.slice(0, cut)))
        pending = pending.slice(cut)
      }
      // Interactive prompts have no trailing newline; flush them shortly after they stop.
      clearTimeout(timer)
      timer = setTimeout(flush, 50)
    },
    end() {
      clearTimeout(timer)
      flush()
    },
  }
}

async function main() {
  const directUrl = process.env.DIRECT_URL
  if (!directUrl) fail("DIRECT_URL is not set in .env.local")

  // The schema engine on Linux reads the CA from this file; keep it identical to the pinned copy.
  if (readFileSync(CA_FILE, "utf8").trim() !== SUPABASE_ROOT_CA.trim()) {
    fail(`${CA_FILE} does not match SUPABASE_ROOT_CA in src/lib/db-ssl.ts`)
  }

  const upstream = new URL(directUrl)
  const relay = await startRelay(upstream.hostname, Number(upstream.port || 5432))
  const { port } = relay.address() as net.AddressInfo

  // Same credentials, database and options, pointed at the loopback relay, which owns TLS.
  const relayUrl = new URL(directUrl)
  relayUrl.hostname = "127.0.0.1"
  relayUrl.port = String(port)
  for (const param of TLS_PARAMS) relayUrl.searchParams.delete(param)
  relayUrl.searchParams.set("sslmode", "disable")

  const secrets = [directUrl, relayUrl.toString(), upstream.password, decodeURIComponent(upstream.password)]
    .filter((s) => s.length >= 4)
  const stdout = redactingWriter(process.stdout, secrets)
  const stderr = redactingWriter(process.stderr, secrets)

  const prismaCli = createRequire(import.meta.url).resolve("prisma/build/index.js")
  const child = spawn(process.execPath, [prismaCli, ...process.argv.slice(2)], {
    env: { ...process.env, PRISMA_TLS_RELAY_URL: relayUrl.toString() },
    stdio: ["inherit", "pipe", "pipe"],
  })
  child.stdout.on("data", (chunk: Buffer) => stdout.write(chunk))
  child.stderr.on("data", (chunk: Buffer) => stderr.write(chunk))

  const forward = (signal: NodeJS.Signals) => () => child.kill(signal)
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, forward(signal))

  const exit = (code: number) => {
    stdout.end()
    stderr.end()
    relay.close()
    process.exit(code)
  }
  child.on("error", (error) => {
    console.error(`Failed to start Prisma CLI: ${error.message}`)
    exit(1)
  })
  child.on("close", (code, signal) => exit(code ?? (signal ? 128 + (signal === "SIGINT" ? 2 : 15) : 1)))
}

main().catch((error: Error) => fail(`TLS relay failed: ${error.message}`))
