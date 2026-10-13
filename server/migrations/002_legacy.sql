-- Handover checklist and long-term maintenance register (AC-18)
CREATE TABLE handover_items (
  id          text PRIMARY KEY,
  project_id  text NOT NULL REFERENCES projects(id),
  title       text NOT NULL,
  status      text NOT NULL CHECK (status IN ('pending','received')),
  document_ref text,
  received_by uuid REFERENCES users(id),
  received_on date
);
CREATE TABLE maintenance_items (
  id          bigserial PRIMARY KEY,
  project_id  text NOT NULL REFERENCES projects(id),
  item        text NOT NULL,
  frequency   text NOT NULL,
  owner       text NOT NULL,
  warranty_until date,
  next_due    date
);
CREATE TABLE maintenance_log (
  id          bigserial PRIMARY KEY,
  item_id     bigint NOT NULL REFERENCES maintenance_items(id),
  done_on     date NOT NULL,
  note        text NOT NULL,
  cost        bigint NOT NULL DEFAULT 0 CHECK (cost >= 0),
  recorded_by uuid NOT NULL REFERENCES users(id)
);
CREATE TRIGGER maintenance_log_append_only BEFORE UPDATE OR DELETE ON maintenance_log FOR EACH ROW EXECUTE FUNCTION forbid_change();
