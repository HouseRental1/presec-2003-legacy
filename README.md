# Class of 2003 Legacy

The legacy platform of the **Presbyterian Boys' Secondary School (PRESEC), Legon — Ɔdadeɛ 2003 year group**. The year group owns it. Its first legacy project is a six-unit classroom block, given by the year group to the PRESEC Legon campus, and the platform is built to carry later projects too. It covers classmates and their houses (PRESEC's eight original houses: Kwansa, Clerk, Engmann, Akro, Riis, Labone, Ako-Adjei and Owusu-Parry), contributions, the house competition, financial controls, construction tracking, secret-ballot voting, an audit trail and the legacy archive. It is built to **Implementation Specification v1.1**.

| Layer | Technology |
|---|---|
| Web app | React 18 + TypeScript, Vite, installable PWA (about 66 KB gzipped) |
| API | Node 22 + TypeScript, Fastify 5, Zod validation |
| Database | PostgreSQL 16; money stored as whole pesewas (`BIGINT`) |
| Tests | Vitest integration tests against a real PostgreSQL database |

## Quick start (development)

```bash
docker compose up -d db                      # or use your own PostgreSQL 16
cp .env.example server/.env                  # adjust if needed
npm install
DATABASE_URL=postgres://legacy:legacy@localhost:5432/class_legacy npm run seed    # SAMPLE data
npm run dev:api                              # API on :8080
npm run dev:web                              # web on :5173 (proxies /api)
```

Sample accounts (development only), all with the password `Legacy-demo-2026`:

| Email | Role |
|---|---|
| ama@presec2003.test | General member |
| kofi@presec2003.test | Treasurer |
| efua@presec2003.test | Finance approver (has a declared conflict with the QS firm) |
| yaw@presec2003.test | Independent reviewer |
| nana@presec2003.test | Project manager |
| abena@presec2003.test | House captain (Clerk House) |
| kwame@presec2003.test | Platform administrator |
| akosua@presec2003.test | Executive committee chair |
| gifty@presec2003.test | School representative |

Every person, firm, house name, figure and exchange rate in the seed is **sample data**.

## Tests

```bash
createdb class_legacy_test                   # once
npm test                                     # 36 tests, ~10 s
DATABASE_URL=... ./scripts/backup-restore-check.sh   # AC-13
```

| Acceptance criterion | Where it is proven |
|---|---|
| AC-01 registration, confirmation, suspension, roles | `platform.test.ts` › AC-01 |
| AC-02 a payment updates statement, project total and house score exactly once | `finance.test.ts` › AC-02 |
| AC-03 pledges never counted as cash | `finance.test.ts` › AC-03 |
| AC-04 reversals keep history; the database refuses edits, deletes and unbalanced postings | `finance.test.ts` › AC-04 |
| AC-05 private data protected; CSRF; captain limits | `platform.test.ts` › AC-05 |
| AC-06 no self-approval, two approvers above threshold, conflict recusal, approver ≠ releaser | `finance.test.ts` › AC-06 |
| AC-07 / AC-08 rankings reproducible; house corrections keep history | `platform.test.ts` › AC-07/08 |
| AC-09 secret ballot, one vote each, eligibility, quorum, two-thirds | `platform.test.ts` › AC-09 |
| AC-10 three-stage progress by different people; open defect blocks 100% | `platform.test.ts` › AC-10 |
| AC-11 budget baselines kept; variations above the threshold need a vote | `platform.test.ts` › AC-09/10 |
| AC-12 reports reconcile to the ledger; settlement shortfalls go to suspense | `finance.test.ts` › AC-12 |
| AC-13 backup can be restored | `scripts/backup-restore-check.sh` |
| AC-14 two-factor sign-in for privileged roles | `platform.test.ts` › AC-14 |
| AC-15 signed, idempotent, amount-checked provider callbacks; FX at the settlement rate | `finance.test.ts` › AC-15 |
| AC-16 usability on phones | Manual user acceptance test with members (still to do) |
| AC-17 audit chain verifies; administrator limit | `platform.test.ts` › AC-17/18 (the security review itself is still to do) |
| AC-18 handover and maintenance records | `platform.test.ts` › AC-17/18 |

## How the important rules are enforced

- **One ledger.** Every cedi is a balanced double-entry transaction. A deferred database trigger rejects any transaction whose debits and credits differ. `ledger_entries`, `ledger_transactions`, `audit_events`, `ballots`, `voter_roll` and `progress_events` are append-only: triggers block `UPDATE` and `DELETE`. Corrections are linked reversing entries.
- **Idempotency.** Each source posts each kind of entry once (`UNIQUE(source_type, source_id, kind)`). A provider or bank reference can be live only once, and replayed webhooks are ignored (`UNIQUE(provider, event_id)`).
- **Maker-checker.** The person who records a manual payment cannot verify it. This is checked in the service layer and again by a database `CHECK`. Reversals also need a second person.
- **Approvals.** A request above `dual_approval_above` needs two distinct approvers. The requester cannot approve. Declared conflicts block approval. The releaser must be the treasurer, cannot be an approver, and the release is refused if reconciled bank funds are short.
- **Contractor payments.** Payments are made only against QS certificates: due = work certified to date − 10% retention − amount paid before. The database `CHECK` and the release step both verify the arithmetic.
- **House competition.** Each house's target is the per-member target × eligible members, frozen when the period starts. The score is 60 × min(achievement, 120%)/120% + 40 × participation. Payments count for the house the member was in on the payment date, and donations count only toward the project. A rule change applies only to a future period, after a member vote.
- **Secret ballot.** The voter roll stores who voted, by date only. The ballot box stores the choice with a random UUID and no member, time or sequence. Both are written in one transaction, and the count is refused if they disagree.
- **Permissions.** Every service function calls `need(actor, permission)`; hiding a button is never the control. Privileged roles need a TOTP code when `REQUIRE_MFA=true`, which is always the case in production.
- **Audit.** Every action is hash-chained (SHA-256 over the previous hash). `GET /api/audit/verify` recomputes the whole chain.
- **Sessions.** The session token is random and only its SHA-256 is stored. It travels in an httpOnly cookie (`SameSite=Lax`, so links from WhatsApp work) and cookie-authenticated writes must carry `X-Requested-With`. Sign-in is rate limited. Passwords use scrypt.

## Production

```bash
docker build -t class-legacy .
# migrate, then bootstrap ONCE on an empty database:
docker run --rm -e DATABASE_URL=... class-legacy node server/dist/migrate-cli.js
docker run --rm -e DATABASE_URL=... -e ADMIN_EMAIL=... -e ADMIN_PASSWORD=... -e ADMIN_NAME=... \
  -e HOUSES="H1:Kwansa,H2:Clerk,H3:Engmann,H4:Akro,H5:Riis,H6:Labone,H7:Ako-Adjei,H8:Owusu-Parry" -e PROJECT_NAME="Legacy Project 1: six-unit classroom block, PRESEC Legon" class-legacy node server/dist/bootstrap.js
docker run -p 8080:8080 -e DATABASE_URL=... -e PAYMENT_WEBHOOK_SECRET=... -e WEB_ORIGIN=https://your.domain class-legacy
```

Run it behind HTTPS (the cookie is `Secure` in production), with automated PostgreSQL backups and a regular run of `backup-restore-check.sh`. The development sandbox endpoint that plays the payment provider is disabled when `NODE_ENV=production`.

## Still needed before launch

These items need decisions, accounts or professionals that a codebase cannot supply:

1. **Payment provider adapter.** `initiate` and `handleWebhook` are provider-neutral, with a signed sandbox. Once the committee chooses a Ghana-supported provider, add its adapter (checkout call, signature format, settlement report) and test it in the provider's sandbox.
2. **Message delivery.** Notifications are stored with their channels (in-app, SMS, email). Connect an SMS and email provider to send them.
3. **File uploads.** Receipts, site photos and drawings need private object storage with expiring links. Evidence is currently recorded as text references.
4. **Admin set-up screens.** The API supports creating ballots and drafting rule versions, but the web app does not have screens for them yet. Entering the contract, budget baseline, work packages and the competition period currently happens by bootstrap/SQL.
5. **Real configuration.** The year group (2003), school (PRESEC Legon), houses (the original eight) and site (PRESEC Legon campus) are set. Still to confirm: the logo, member numbering, approval thresholds, quorum, fees, committee members and the legal custody details all need confirming (see the spec's decisions register).
6. **Security review and user testing (AC-16, AC-17).** Commission an independent penetration test and a data-protection review under Ghana's Data Protection Act. Run user acceptance testing with representative members on their own phones.
