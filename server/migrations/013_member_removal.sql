-- Super admins can remove a classmate. People with history (sign-ins, payments, pledges, votes) are archived,
-- not erased, so the ledger and audit trail stay complete.
ALTER TABLE members ADD COLUMN removed_at timestamptz, ADD COLUMN removed_by uuid REFERENCES users(id), ADD COLUMN removed_reason text;
