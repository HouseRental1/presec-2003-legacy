# Deploying Class of 2003 Legacy on Vercel

The app is one Vercel project: a Fastify function that serves the API and the web app, with a Neon PostgreSQL database. Allow about an hour for the first deployment.

## 1. Accounts you need

| Service | What for | Notes |
|---|---|---|
| GitHub | The code repository | Keep it **private**. |
| Vercel | Hosting | Hobby (free) is meant for personal, non-commercial use and runs scheduled jobs once a day. Check Vercel's terms for a year-group association; Pro removes those limits. |
| Neon (through Vercel) | The database | Add it from the Vercel project's **Storage** tab. It sets `DATABASE_URL` for you. |
| Paystack | MoMo and card payments | Start with **test keys**. Live keys need the association's business verification. |
| SMS provider (later) | Texts | Until chosen, `SMS_PROVIDER=log` records messages without sending them. |
| Resend (optional) | Email | Needs a verified sending domain. |

## 2. Create the Vercel project

1. In Vercel, choose **Add New → Project** and import the GitHub repository.
2. Leave **Root Directory** as `./`. Vercel detects Fastify, and `vercel.json` sets the install and build commands.
3. Open **Storage → Create → Neon Postgres** and connect it to the project, in all environments. Pick the region closest to Ghana (for example AWS London, eu-west-2), then set the project's **Functions region** to match (for example `lhr1`).
4. Under **Settings → Environment Variables**, add the following:

| Variable | Value |
|---|---|
| `APP_URL` | `https://<your-domain>` (or the `*.vercel.app` address at first) |
| `WEB_ORIGIN` | Same as `APP_URL` |
| `DB_POOL_MAX` | `3` |
| `PAYMENT_PROVIDER` | `paystack` |
| `PAYSTACK_SECRET_KEY` | `sk_test_…` (switch to `sk_live_…` at launch) |
| `PAYSTACK_ENFORCE_IPS` | `true` |
| `CRON_SECRET` | A long random string (Vercel sends it to the scheduled jobs) |
| `SMS_PROVIDER` | `log` for now (`arkesel` or `hubtel` later, with their keys) |
| `SMS_SENDER_ID` | `PRESEC03` (must be registered with the SMS provider) |
| `EMAIL_PROVIDER` / `RESEND_API_KEY` / `EMAIL_FROM` | Optional; `log` until set |

5. Choose **Deploy**. The build compiles the API, applies the database migrations and builds the web app.

## 3. Create the first administrator (once)

The simplest way is through Vercel itself:

1. In **Settings → Environment Variables**, add `ADMIN_EMAIL`, `ADMIN_PASSWORD` (14+ characters) and `ADMIN_NAME`.
2. Redeploy. The build log shows `Bootstrapped. Sign in as …`.
3. **Delete `ADMIN_PASSWORD` from Vercel** once you have signed in. The set-up runs only while the database has no users, so later deploys skip it either way.

It creates the chart of accounts, the default control settings, PRESEC's eight original houses, Legacy Project 1 and the one administrator. (Alternatively, run `node server/dist/bootstrap.js` from your own computer with the same variables and the Neon direct connection string.)

## 4. Connect Paystack

1. In the Paystack dashboard, open **Settings → API Keys & Webhooks**.
2. Set the webhook URL to `https://<your-domain>/api/webhooks/payments/paystack`.
3. The return page (`/pay/return`) is set automatically for each payment.
4. Make a test payment with Paystack's test cards or test MoMo numbers. Check that it appears as **Verified** on your statement and in **Money → Ledger**.

A payment counts only after Paystack's signed webhook arrives **and** the app confirms it through Paystack's verify API. The browser redirect on its own is never treated as proof of payment.

## 5. First sign-in and set-up

1. Sign in as the administrator, then go to **Profile → Set up two-factor sign-in**. In production, staff actions are blocked until two-factor sign-in is on.
2. **Administration → Year-group register:** paste the register as CSV. Every classmate with an email gets an invitation by email and SMS.
3. **Administration → Roles & captains:** give roles to the committee, treasurer, finance approvers, independent reviewer and project manager, and appoint the eight house captains. Each of them sets up two-factor sign-in.
4. **Administration → Controls & rules:** confirm the approval thresholds, quorum and fees, then open the first competition period.
5. **Administration → Project set-up:** after the member vote, record the contract and the budget baseline, then the work packages (their weights must total 100%).
6. **Administration → Ballots:** open ballots for the decisions the year group must take.

## 6. Scheduled jobs

`vercel.json` sets up two scheduled jobs:

- **Daily at 07:00 UTC:** send any messages still queued and freeze house sizes when a competition period starts. Messages normally go out straight after each action; this job is a safety net.
- **1st of each month at 09:00 UTC:** gentle pledge reminders. Members who turned off SMS reminders don't get them.

## 7. Before going live

- [ ] Switch to live Paystack keys and complete one real GH₵ 1 payment from start to finish.
- [ ] Choose the SMS provider, register the sender ID and set its keys.
- [ ] Set up a custom domain in Vercel, then update `APP_URL` and `WEB_ORIGIN`.
- [ ] Turn on Neon's point-in-time restore. Run `scripts/backup-restore-check.sh` against a Neon branch.
- [ ] Get an independent security review and a data-protection review (Ghana Data Protection Act).
- [ ] Run user acceptance testing with members on their own phones.
- [ ] Delete any test data. Never run `npm run seed` against production; it refuses when `NODE_ENV=production`.
