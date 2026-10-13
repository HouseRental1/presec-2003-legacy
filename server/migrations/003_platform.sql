-- Platform features: provider checkout, messaging, invites, files, community, profile, throttling

-- payment provider checkout details (Paystack)
ALTER TABLE payments ADD COLUMN provider text;
ALTER TABLE payments ADD COLUMN checkout_url text;
ALTER TABLE payments ADD COLUMN payer_email text;
ALTER TABLE payments ADD COLUMN evidence_file uuid;

-- contact details & preferences
ALTER TABLE members ADD COLUMN email text;
ALTER TABLE members ADD COLUMN sms_reminders boolean NOT NULL DEFAULT true;
ALTER TABLE members ADD COLUMN email_updates boolean NOT NULL DEFAULT true;

-- message kind decides whether member preferences apply (payment, governance and security always send)
ALTER TABLE notifications ADD COLUMN kind text NOT NULL DEFAULT 'general' CHECK (kind IN ('payment','governance','security','reminder','general'));
ALTER TABLE notifications ADD COLUMN expanded boolean NOT NULL DEFAULT false;

-- one row per recipient per channel; dispatched by the cron job
CREATE TABLE notification_deliveries (
  id              bigserial PRIMARY KEY,
  notification_id bigint NOT NULL REFERENCES notifications(id),
  channel         text NOT NULL CHECK (channel IN ('sms','email')),
  recipient       text NOT NULL,
  status          text NOT NULL CHECK (status IN ('queued','sent','failed','skipped')) DEFAULT 'queued',
  provider        text,
  provider_ref    text,
  error           text,
  attempts        int NOT NULL DEFAULT 0,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (notification_id, channel, recipient)
);
CREATE INDEX ON notification_deliveries (status);

-- invitations and password resets (only the token hash is stored)
CREATE TABLE account_tokens (
  token_hash text PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id),
  purpose    text NOT NULL CHECK (purpose IN ('invite','reset')),
  expires_at timestamptz NOT NULL,
  used_at    timestamptz
);

-- private files stored in the database (backed up with everything else)
CREATE TABLE files (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind        text NOT NULL CHECK (kind IN ('payment_evidence','site_photo','inspection','handover','defect','general')),
  linked_type text,
  linked_id   text,
  file_name   text NOT NULL,
  mime        text NOT NULL CHECK (mime IN ('image/jpeg','image/png','image/webp','application/pdf')),
  size_bytes  int NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 3000000),
  sha256      text NOT NULL,
  bytes       bytea NOT NULL,
  uploaded_by uuid NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON files (linked_type, linked_id);
ALTER TABLE payments ADD CONSTRAINT payments_evidence_fk FOREIGN KEY (evidence_file) REFERENCES files(id);
ALTER TABLE progress_events ADD COLUMN file_id uuid REFERENCES files(id);

-- community
CREATE TABLE announcements (
  id         bigserial PRIMARY KEY,
  title      text NOT NULL,
  body       text NOT NULL,
  audience   text NOT NULL DEFAULT 'all',
  posted_by  uuid NOT NULL REFERENCES users(id),
  posted_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE events (
  id         bigserial PRIMARY KEY,
  title      text NOT NULL,
  starts_at  timestamptz NOT NULL,
  venue      text NOT NULL,
  details    text NOT NULL DEFAULT '',
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE event_rsvps (
  event_id  bigint NOT NULL REFERENCES events(id),
  member_id uuid NOT NULL REFERENCES members(id),
  response  text NOT NULL CHECK (response IN ('yes','no','maybe')),
  guests    int NOT NULL DEFAULT 0 CHECK (guests BETWEEN 0 AND 5),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, member_id)
);

-- sign-in throttling that works across serverless instances
CREATE TABLE login_failures (
  id    bigserial PRIMARY KEY,
  email text NOT NULL,
  ip    text,
  at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON login_failures (email, at);
