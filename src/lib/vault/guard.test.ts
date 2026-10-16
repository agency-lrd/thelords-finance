import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { generatePassword, secretReason } from "./guard"

describe("secretReason", () => {
  it("refuses secrets", () => {
    assert.equal(secretReason("Пароль: Qwerty123!"), "password")
    assert.equal(secretReason("password=hunter2"), "password")
    assert.equal(secretReason("-----BEGIN OPENSSH PRIVATE KEY-----\nabc"), "private key")
    assert.equal(secretReason("key sk-proj-abcdefghijklmnopqrstuvwx"), "API key")
    assert.equal(secretReason("AKIAIOSFODNN7EXAMPLE"), "API key")
    assert.equal(secretReason("abandon ability able about above absent absorb abstract absurd abuse access accident"), "seed phrase")
    assert.equal(secretReason("0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318"), "crypto private key")
    assert.equal(secretReason("https://admin:secret@example.com/login"), "credentials in URL")
    assert.equal(secretReason("Резервные коды: 1234 5678"), "recovery code")
  })
  it("allows normal notes", () => {
    assert.equal(secretReason("Доступ у Саши, 2FA на телефоне руководителя. Продление в марте."), null)
    assert.equal(secretReason("https://business.facebook.com/"), null)
    assert.equal(secretReason("agency@thelords.group"), null)
    assert.equal(secretReason(null), null)
  })
})

describe("generatePassword", () => {
  it("has the requested length and every character class", () => {
    for (let i = 0; i < 50; i++) {
      const p = generatePassword(20)
      assert.equal(p.length, 20)
      assert.match(p, /[a-z]/)
      assert.match(p, /[A-Z]/)
      assert.match(p, /[0-9]/)
      assert.match(p, /[^A-Za-z0-9]/)
    }
    assert.notEqual(generatePassword(), generatePassword())
  })
})
