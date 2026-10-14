-- Self sign-up from the sign-in page; an administrator approves before an account exists.
CREATE TABLE signup_requests (
  id            bigserial PRIMARY KEY,
  full_name     text NOT NULL,
  email         text NOT NULL CHECK (email = lower(email)),
  phone         text,
  house_id      text REFERENCES houses(id),
  city          text,
  profession    text,
  note          text,
  password_hash text NOT NULL,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  ip            text,
  decided_by    uuid REFERENCES users(id),
  decided_at    timestamptz,
  decision_note text,
  member_no     text
);
CREATE UNIQUE INDEX one_pending_signup_per_email ON signup_requests (email) WHERE status = 'pending';
