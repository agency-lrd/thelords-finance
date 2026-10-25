import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { parseAuthHash, PRODUCTION_ORIGIN, recoveryError, safeNext, siteOrigin } from "./recovery"

describe("password recovery helpers", () => {
  it("links in emails use our own domain, never a foreign host", () => {
    assert.equal(siteOrigin("www.osfnclrd.com", "https"), "https://www.osfnclrd.com")
    assert.equal(siteOrigin("osfnclrd.com", "http"), "https://osfnclrd.com")
    assert.equal(siteOrigin("thelords-finance.vercel.app", null), "https://thelords-finance.vercel.app")
    assert.equal(siteOrigin("localhost:3000", "http"), "http://localhost:3000")
    assert.equal(siteOrigin("evil.example.com", "https"), PRODUCTION_ORIGIN)
    assert.equal(siteOrigin(null, null), PRODUCTION_ORIGIN)
  })
  it("only same-site relative destinations are followed", () => {
    assert.equal(safeNext("/reset-password"), "/reset-password")
    assert.equal(safeNext("//evil.com"), "/")
    assert.equal(safeNext("https://evil.com"), "/")
    assert.equal(safeNext("/\\evil.com"), "/")
    assert.equal(safeNext(null, "/x"), "/x")
  })
  it("Supabase errors map to clear messages", () => {
    assert.equal(recoveryError("otp_expired", "Email link is invalid or has expired"), "expired")
    assert.equal(recoveryError("same_password", null), "same_password")
    assert.equal(recoveryError("weak_password", null), "weak_password")
    assert.equal(recoveryError("over_email_send_rate_limit", null), "rate_limit")
    assert.equal(recoveryError(null, "Auth session missing!"), "no_session")
    assert.equal(recoveryError("bad_code_verifier", null), "invalid")
  })
  it("reads implicit-flow tokens and errors from the URL fragment", () => {
    const ok = parseAuthHash("#access_token=a.b.c&refresh_token=r1&type=recovery&expires_in=3600")
    assert.deepEqual([ok.accessToken, ok.refreshToken, ok.type, ok.error], ["a.b.c", "r1", "recovery", null])
    const bad = parseAuthHash("#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired")
    assert.deepEqual([bad.error, bad.errorDescription], ["otp_expired", "Email link is invalid or has expired"])
  })
})
