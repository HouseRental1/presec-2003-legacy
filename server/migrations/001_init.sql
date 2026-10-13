-- Class of [Year] Legacy — initial schema (spec v1.1)
-- Money is stored as BIGINT pesewas (1 GHS = 100 pesewas). Never floats.
-- Posted ledger lines and audit events are append-only (enforced by triggers).

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ───────────────────────── identity & access
CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL UNIQUE CHECK (email = lower(email)),
  password_hash text NOT NULL,
  display_name  text NOT NULL,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  totp_secret   text,                      -- base32; required for privileged roles when MFA is enforced
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE user_roles (
  user_id    uuid NOT NULL REFERENCES users(id),
  role       text NOT NULL CHECK (role IN ('admin','committee','treasurer','approver','auditor','pm','captain','member','school')),
  granted_by uuid REFERENCES users(id),
  granted_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,                  -- temporary delegation
  PRIMARY KEY (user_id, role)
);

CREATE TABLE sessions (
  token_hash text PRIMARY KEY,             -- sha256 of the bearer/cookie token; raw token never stored
  user_id    uuid NOT NULL REFERENCES users(id),
  mfa_passed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX ON sessions (user_id);

-- ───────────────────────── members & houses
CREATE TABLE houses (
  id   text PRIMARY KEY,
  name text NOT NULL UNIQUE
);

CREATE TABLE members (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_no   text NOT NULL UNIQUE,
  user_id     uuid UNIQUE REFERENCES users(id),
  full_name   text NOT NULL,
  city        text,
  profession  text,
  phone       text,
  home_currency char(3) NOT NULL DEFAULT 'GHS',
  verified_at timestamptz,
  verified_by uuid REFERENCES users(id),
  show_on_wall boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Effective-dated house membership: corrections never rewrite history.
CREATE TABLE house_memberships (
  id         bigserial PRIMARY KEY,
  member_id  uuid NOT NULL REFERENCES members(id),
  house_id   text NOT NULL REFERENCES houses(id),
  valid_from date NOT NULL,
  valid_to   date,
  reason     text NOT NULL,
  changed_by uuid REFERENCES users(id),
  CHECK (valid_to IS NULL OR valid_to >= valid_from)
);
CREATE UNIQUE INDEX one_open_membership ON house_memberships (member_id) WHERE valid_to IS NULL;

CREATE TABLE house_captains (
  house_id text NOT NULL REFERENCES houses(id),
  user_id  uuid NOT NULL REFERENCES users(id),
  PRIMARY KEY (house_id, user_id)
);

-- ───────────────────────── settings & competition rules
CREATE TABLE settings (
  key   text PRIMARY KEY,
  value jsonb NOT NULL
);

CREATE TABLE competition_rules (
  version            text PRIMARY KEY,
  status             text NOT NULL CHECK (status IN ('draft','in_force','retired','rejected')),
  period_name        text NOT NULL,
  period_start       date NOT NULL,
  period_end         date NOT NULL,
  per_member_target  bigint NOT NULL CHECK (per_member_target > 0),   -- pesewas
  weight_target      int NOT NULL,
  weight_participation int NOT NULL,
  cap_bp             int NOT NULL DEFAULT 12000,                      -- 120% = 12000 basis points
  eligible_snapshot  jsonb,                                           -- {"H1":112,...} frozen at period start
  approved_by        text,
  CHECK (weight_target + weight_participation = 100),
  CHECK (period_end > period_start)
);

-- ───────────────────────── projects
CREATE TABLE projects (
  id     text PRIMARY KEY,
  name   text NOT NULL,
  status text NOT NULL
);

CREATE TABLE budget_versions (
  project_id text NOT NULL REFERENCES projects(id),
  version    int  NOT NULL,
  total      bigint NOT NULL,
  lines      jsonb NOT NULL,
  approved_by text NOT NULL,
  note       text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, version)
);

CREATE TABLE suppliers (
  id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE
);

CREATE TABLE coi_declarations (
  id          text PRIMARY KEY,
  user_id     uuid REFERENCES users(id),
  member_id   uuid REFERENCES members(id),
  supplier_id uuid NOT NULL REFERENCES suppliers(id),
  interest    text NOT NULL,
  action      text NOT NULL,
  declared_at date NOT NULL
);

CREATE TABLE contracts (
  id            text PRIMARY KEY,
  project_id    text NOT NULL REFERENCES projects(id),
  supplier_id   uuid NOT NULL REFERENCES suppliers(id),
  value         bigint NOT NULL CHECK (value > 0),
  retention_bp  int NOT NULL DEFAULT 1000,  -- 10%
  signed_on     date NOT NULL,
  start_on      date NOT NULL,
  end_on        date NOT NULL
);

-- ───────────────────────── ledger (double entry, append-only)
CREATE TABLE ledger_accounts (
  code   text PRIMARY KEY,
  name   text NOT NULL,
  normal text NOT NULL CHECK (normal IN ('debit','credit'))
);

CREATE TABLE ledger_transactions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id     text NOT NULL REFERENCES projects(id),
  kind           text NOT NULL,
  source_type    text NOT NULL,
  source_id      text NOT NULL,
  effective_date date NOT NULL,
  memo           text NOT NULL,
  reversal_of    uuid REFERENCES ledger_transactions(id),
  posted_by      uuid REFERENCES users(id),
  posted_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_type, source_id, kind)      -- idempotency: a source posts each kind only once
);

CREATE TABLE ledger_entries (
  id       bigserial PRIMARY KEY,
  txn_id   uuid NOT NULL REFERENCES ledger_transactions(id),
  account  text NOT NULL REFERENCES ledger_accounts(code),
  debit    bigint NOT NULL DEFAULT 0 CHECK (debit  >= 0),
  credit   bigint NOT NULL DEFAULT 0 CHECK (credit >= 0),
  CHECK ((debit = 0) <> (credit = 0))
);
CREATE INDEX ON ledger_entries (txn_id);
CREATE INDEX ON ledger_entries (account);

-- Every transaction must balance when the database transaction commits.
CREATE FUNCTION check_txn_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d bigint; c bigint;
BEGIN
  SELECT coalesce(sum(debit),0), coalesce(sum(credit),0) INTO d, c FROM ledger_entries WHERE txn_id = NEW.txn_id;
  IF d <> c OR d = 0 THEN
    RAISE EXCEPTION 'ledger transaction % is not balanced (debits %, credits %)', NEW.txn_id, d, c;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER ledger_balanced AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_txn_balanced();

CREATE FUNCTION forbid_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: post a correcting entry instead', TG_TABLE_NAME;
END $$;
CREATE TRIGGER ledger_entries_append_only BEFORE UPDATE OR DELETE ON ledger_entries FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER ledger_txn_append_only     BEFORE UPDATE OR DELETE ON ledger_transactions FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- ───────────────────────── pledges & payments
CREATE TABLE pledges (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id  uuid NOT NULL REFERENCES members(id),
  project_id text NOT NULL REFERENCES projects(id),
  amount     bigint NOT NULL CHECK (amount > 0),
  instalments int NOT NULL CHECK (instalments BETWEEN 1 AND 24),
  status     text NOT NULL CHECK (status IN ('active','adjusted','cancelled')),
  replaces   uuid REFERENCES pledges(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE payments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      text NOT NULL REFERENCES projects(id),
  member_id       uuid REFERENCES members(id),           -- credited member (null while unmatched)
  payer_name      text,                                  -- when someone pays on behalf / company / unknown
  category        text NOT NULL DEFAULT 'member' CHECK (category IN ('member','donor')),
  channel         text NOT NULL CHECK (channel IN ('momo','card','bank','cash')),
  network         text,
  source          text NOT NULL CHECK (source IN ('gateway','manual','import','self')),
  currency        char(3) NOT NULL,
  amount_original bigint NOT NULL CHECK (amount_original > 0),   -- minor units of original currency
  fx_rate         numeric(14,6) NOT NULL DEFAULT 1 CHECK (fx_rate > 0),
  amount_ghs      bigint NOT NULL CHECK (amount_ghs > 0),        -- gross, credited to member/house
  fee_ghs         bigint NOT NULL DEFAULT 0 CHECK (fee_ghs >= 0),
  external_ref    text NOT NULL,
  paid_on         date NOT NULL,
  status          text NOT NULL CHECK (status IN ('pending','verified','exception','rejected','reversal_requested','reversed')),
  exception_reason text,
  evidence_note   text,
  recorded_by     uuid REFERENCES users(id),             -- null for gateway
  verified_by     uuid REFERENCES users(id),
  verified_at     timestamptz,
  reversal_reason text,
  reversal_requested_by uuid REFERENCES users(id),
  settlement_id   uuid,
  receipt_no      text UNIQUE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (verified_by IS NULL OR recorded_by IS NULL OR verified_by <> recorded_by)   -- maker-checker
);
-- A provider/bank reference can be live only once (rejected duplicates are kept for the record).
CREATE UNIQUE INDEX payments_ref_unique ON payments (channel, external_ref) WHERE status NOT IN ('rejected');
CREATE INDEX ON payments (member_id);
CREATE INDEX ON payments (status);

CREATE TABLE provider_events (
  id           bigserial PRIMARY KEY,
  provider     text NOT NULL,
  event_id     text NOT NULL,
  payload      jsonb NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now(),
  outcome      text NOT NULL,
  UNIQUE (provider, event_id)                -- replayed webhooks are ignored
);

CREATE TABLE settlements (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider      text NOT NULL,
  settled_on    date NOT NULL,
  expected      bigint NOT NULL,
  statement     bigint NOT NULL,
  status        text NOT NULL CHECK (status IN ('matched','difference')),
  recorded_by   uuid NOT NULL REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE payments ADD CONSTRAINT payments_settlement_fk FOREIGN KEY (settlement_id) REFERENCES settlements(id);

-- ───────────────────────── payments out
CREATE TABLE payment_certificates (
  id                text PRIMARY KEY,
  contract_id       text NOT NULL REFERENCES contracts(id),
  issued_on         date NOT NULL,
  gross_to_date     bigint NOT NULL,
  retention_to_date bigint NOT NULL,
  previous_paid     bigint NOT NULL,
  due               bigint NOT NULL,
  issued_by         text NOT NULL,
  CHECK (due = gross_to_date - retention_to_date - previous_paid)
);

CREATE TABLE payment_requests (
  id            text PRIMARY KEY,
  project_id    text NOT NULL REFERENCES projects(id),
  title         text NOT NULL,
  supplier_id   uuid NOT NULL REFERENCES suppliers(id),
  amount        bigint NOT NULL CHECK (amount > 0),
  category      text NOT NULL,
  certificate_id text UNIQUE REFERENCES payment_certificates(id),
  required_approvals int NOT NULL CHECK (required_approvals BETWEEN 1 AND 3),
  status        text NOT NULL CHECK (status IN ('awaiting','approved','paid','rejected')),
  requested_by  uuid NOT NULL REFERENCES users(id),
  released_by   uuid REFERENCES users(id),
  released_on   date,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE request_decisions (
  request_id text NOT NULL REFERENCES payment_requests(id),
  user_id    uuid NOT NULL REFERENCES users(id),
  decision   text NOT NULL CHECK (decision IN ('approved','rejected')),
  decided_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (request_id, user_id)
);

-- ───────────────────────── construction
CREATE TABLE work_packages (
  id         text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(id),
  name       text NOT NULL,
  weight_bp  int NOT NULL CHECK (weight_bp BETWEEN 0 AND 10000),
  budget     bigint NOT NULL,
  reported_pct int NOT NULL DEFAULT 0 CHECK (reported_pct BETWEEN 0 AND 100),
  verified_pct int NOT NULL DEFAULT 0 CHECK (verified_pct BETWEEN 0 AND 100),
  accepted_pct int NOT NULL DEFAULT 0 CHECK (accepted_pct BETWEEN 0 AND 100),
  CHECK (accepted_pct <= verified_pct AND verified_pct <= reported_pct)
);

CREATE TABLE progress_events (
  id          bigserial PRIMARY KEY,
  wp_id       text NOT NULL REFERENCES work_packages(id),
  stage       text NOT NULL CHECK (stage IN ('reported','verified','accepted')),
  pct         int NOT NULL CHECK (pct BETWEEN 0 AND 100),
  evidence    text NOT NULL,
  recorded_by uuid NOT NULL REFERENCES users(id),
  recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER progress_append_only BEFORE UPDATE OR DELETE ON progress_events FOR EACH ROW EXECUTE FUNCTION forbid_change();

CREATE TABLE variations (
  id          text PRIMARY KEY,
  project_id  text NOT NULL REFERENCES projects(id),
  wp_id       text REFERENCES work_packages(id),
  title       text NOT NULL,
  amount      bigint NOT NULL CHECK (amount > 0),
  reason      text NOT NULL,
  funded_from text NOT NULL CHECK (funded_from IN ('contingency','budget_revision')),
  route       text NOT NULL CHECK (route IN ('committee','member_vote')),
  status      text NOT NULL CHECK (status IN ('awaiting_committee','awaiting_vote','approved','rejected')),
  proposal_id text,
  decided_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE inspections (
  id         text PRIMARY KEY,
  wp_id      text NOT NULL REFERENCES work_packages(id),
  inspected_on date NOT NULL,
  inspector  text NOT NULL,
  result     text NOT NULL CHECK (result IN ('passed','passed_with_defect','failed')),
  note       text
);

CREATE TABLE defects (
  id        text PRIMARY KEY,
  wp_id     text NOT NULL REFERENCES work_packages(id),
  title     text NOT NULL,
  action    text NOT NULL,
  due_on    date NOT NULL,
  status    text NOT NULL CHECK (status IN ('open','closed')),
  closed_by uuid REFERENCES users(id),
  closure_evidence text
);

CREATE TABLE risks (
  id     text PRIMARY KEY,
  title  text NOT NULL,
  level  text NOT NULL CHECK (level IN ('Low','Medium','High')),
  owner  text NOT NULL,
  action text NOT NULL
);

-- ───────────────────────── governance (secret ballot)
CREATE TABLE proposals (
  id          text PRIMARY KEY,
  title       text NOT NULL,
  description text NOT NULL,
  threshold   text NOT NULL CHECK (threshold IN ('simple','two_thirds')),
  quorum_bp   int  NOT NULL CHECK (quorum_bp BETWEEN 0 AND 10000),
  opens_on    date NOT NULL,
  closes_on   date NOT NULL,
  status      text NOT NULL CHECK (status IN ('open','closed')),
  result      text CHECK (result IN ('passed','not_passed','no_quorum')),
  eligible_count int NOT NULL,                 -- frozen at opening
  linked_type text,
  linked_id   text,
  closed_by   uuid REFERENCES users(id),
  yes_count int, no_count int, abstain_count int
);
-- Who voted (prevents double voting). Holds NO choice.
CREATE TABLE voter_roll (
  proposal_id text NOT NULL REFERENCES proposals(id),
  member_id   uuid NOT NULL REFERENCES members(id),
  voted_on    date NOT NULL,                   -- date only, so time cannot link roll to ballot
  PRIMARY KEY (proposal_id, member_id)
);
-- What was chosen. Holds NO member reference, no timestamp, random key.
CREATE TABLE ballots (
  token       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id text NOT NULL REFERENCES proposals(id),
  choice      text NOT NULL CHECK (choice IN ('yes','no','abstain'))
);
CREATE TRIGGER ballots_append_only BEFORE UPDATE OR DELETE ON ballots FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER voter_roll_append_only BEFORE UPDATE OR DELETE ON voter_roll FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- ───────────────────────── notifications & audit
CREATE TABLE notifications (
  id         bigserial PRIMARY KEY,
  audience   text NOT NULL,     -- 'all' | 'member:<uuid>' | 'perm:<perm>' | 'house:<id>'
  channels   text[] NOT NULL,
  body       text NOT NULL,     -- never contains balances or full references when sent by SMS
  created_at timestamptz NOT NULL DEFAULT now(),
  delivery   jsonb NOT NULL DEFAULT '{}'
);

CREATE TABLE audit_events (
  seq        bigserial PRIMARY KEY,
  at         timestamptz NOT NULL DEFAULT now(),
  actor_id   uuid REFERENCES users(id),
  actor_label text NOT NULL,
  action     text NOT NULL,
  target     text NOT NULL,
  detail     text NOT NULL DEFAULT '',
  prev_hash  text NOT NULL,
  hash       text NOT NULL
);
CREATE TRIGGER audit_append_only BEFORE UPDATE OR DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION forbid_change();

CREATE TABLE schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
