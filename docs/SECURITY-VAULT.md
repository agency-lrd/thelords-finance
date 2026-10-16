# Password vault: security architecture (for approval)

Status: **Decision (2026-10-18, approved by the owner): Option A.** Passwords and other secrets stay in
Bitwarden or 1Password; THE LORDS Finance OS is only the access register. No passwords, recovery codes,
API keys or other secrets are ever stored in Finance OS. Options B and C below are kept for reference only
and must not be built without a new approval.

## Current authorization architecture

- **Sign-in:** Supabase Auth with email and password. MFA (TOTP) is available in Supabase but is not
  enrolled or enforced yet.
- **Access control:**
  - Application users (`app_users`) get roles per organization (Owner, CFO, Finance Manager,
    Department Head, HR, Employee, Read Only).
  - Each role is a set of permissions. Super Admin is platform-wide.
  - Every Server Action and page checks permissions on the server.
  - The database re-checks critical approvals in triggers.
- **Data:** every table has row-level security. The browser-facing API roles (`anon`, `authenticated`) have
  no table privileges, so the only writer is the server.
- **Audit:** `audit_logs` is append-only; updates, deletes and truncates are blocked by triggers.
- **Existing encryption:** wallet addresses use AES-256-GCM with `WALLET_ENCRYPTION_KEY`. That key lives in
  the server environment, which is also where the database credentials live. This is acceptable for masked
  payout addresses. It is **not** acceptable for a password vault: anyone who compromises the server gets
  both the ciphertext and the key.

## What is implemented now (safe part)

- **Navigation "Пароли":** a credential **metadata** register. Each entry has: service, login URL,
  username, department, category, responsible employee, access level, notes, a reference to the item in an
  external password manager, created and updated dates, and an archive flag.
- **Explicit access:** each entry is shared with named users, with view or edit rights.
  - Super Admin and holders of the new `vault:manage` permission (Owner role) see every entry. This is the
    company-wide policy.
  - Everyone else, including Department Heads, sees only entries explicitly shared with them. Department
    membership never grants access.
- **History:** every view, username copy, login-URL open, change, share and unshare goes to the append-only
  audit log. Holders of `vault:audit` (Owner) can see each entry's history.
- **Secret guard:** the server refuses to save notes, usernames or URLs that look like secrets. It detects
  `password:`-style lines, private-key blocks, common API-key formats and 12/24-word seed phrases.
- **Password generator:** runs in the browser only, using `crypto.getRandomValues`. The generated password
  is never sent to the server; you copy it into your password manager.
- **Exports:** the register has no export, so no credential data leaves through files.
- **Server-side only:** the database has no column for passwords.

## Options for storing the secrets themselves

### Option A: Bitwarden or 1Password as the system of record (recommended)

Use **Bitwarden Teams/Enterprise** or **1Password Business** for all secrets. Finance OS keeps only the
metadata and the item reference (already implemented).

- **Encryption:**
  - End-to-end, with keys derived on members' devices. Neither our server nor the provider can read the
    secrets.
  - Audited, established cryptography. We write none of our own.
- **Access:**
  - Collections or vaults mirror our departments, and items are shared per person or group.
  - MFA, SSO and device approval are enforced by the provider.
  - Recovery and offboarding (revoking a leaver) are handled by the provider's admin console.
- **In Finance OS:**
  - Each entry links to its item (an "Open in Bitwarden/1Password" link is already there).
  - The register shows who is responsible and who should have access.
  - Our access list stays a register of intent. Optionally, a later integration can compare it with the
    provider's access (read-only, metadata only).
- **Cost:** per-user licences; no secret-handling code in this app.
- **Risk:** the lowest of the three options.

### Option B: provider integration through its server API (later, optional)

Use **1Password Connect** or the **Bitwarden Secrets Manager SDK** to show a secret inside Finance OS after
step-up MFA.

- **Requirements:**
  - Supabase MFA (TOTP) enrolled and an AAL2 session required for reveal and copy.
  - The provider token stored only in Vercel environment variables, scoped to a dedicated read-only vault.
  - Reveal returns the secret once, with `Cache-Control: no-store`, never logged, rate-limited, and fully
    audited.
- **Risk:** our server can now read secrets, so a server compromise exposes the integrated vault. Use it
  only for items that genuinely need in-app access.

### Option C: native vault in Finance OS (needs explicit approval; not recommended)

Only if A and B are impossible. Minimum design:

- **Envelope encryption:**
  - Each secret is encrypted with its own random data key (AES-256-GCM).
  - That data key is encrypted by a key-encryption key held in a cloud KMS or HSM (AWS KMS, Google Cloud
    KMS), **never** in our environment variables or database.
  - The server calls the KMS to decrypt, which gives a separate audit trail.
- **Step-up MFA** (Supabase TOTP, AAL2) on every reveal and copy, with a re-authentication window of 5
  minutes or less.
- **Additional protection** for financial-platform credentials, recovery codes and API keys:
  - a separate KMS key;
  - two-person approval to reveal or share;
  - rotation reminders.
- **Strict handling:**
  - Secrets never appear in logs, analytics, AI prompts, exports or error messages.
  - The redaction layer is unit-tested.
  - Responses are not cached.
- **Assurance:** a security review or pentest before any production secrets.
- **Risk:** we own the cryptography lifecycle (key rotation, backups, breach response). Highest risk and
  effort.

### Never stored, in any option

Crypto wallet seed phrases and private keys. These belong only in hardware wallets or the custody solution,
never in a CRM or a shared password manager collection.

## Decision

**Option A is approved** (2026-10-18). Next steps for the team, outside this app:

1. Choose Bitwarden Teams/Enterprise or 1Password Business. Create collections (Bitwarden) or vaults
   (1Password) per department, and enforce MFA for every member.
2. Move existing passwords there. Delete them from spreadsheets, chats and notes.
3. In Finance OS → Пароли, add one entry per service with the link to its item in the password manager,
   the responsible employee, and the people who should have access.

Option B would need a separate approval, with MFA enrolled first for everyone who has vault access.
