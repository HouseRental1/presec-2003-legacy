-- Project lifecycle: details (charter), five phases with stage gates, deliverable checklists,
-- and progress updates. Templates are created for every existing project.

ALTER TABLE projects
  ADD COLUMN description   text,
  ADD COLUMN site          text,
  ADD COLUMN objectives    text,
  ADD COLUMN scope         text,
  ADD COLUMN sponsor       text,
  ADD COLUMN school_contact text,
  ADD COLUMN planned_start date,
  ADD COLUMN planned_end   date;

CREATE TABLE project_phases (
  project_id   text NOT NULL REFERENCES projects(id),
  key          text NOT NULL CHECK (key IN ('initiation','planning','procurement','execution','closing')),
  seq          int  NOT NULL,
  name         text NOT NULL,
  purpose      text NOT NULL,
  status       text NOT NULL DEFAULT 'not_started' CHECK (status IN ('not_started','in_progress','complete')),
  planned_start date,
  planned_end   date,
  actual_start  date,
  actual_end    date,
  gate_approved_by uuid REFERENCES users(id),
  gate_approved_at timestamptz,
  gate_note     text,
  PRIMARY KEY (project_id, key),
  UNIQUE (project_id, seq)
);

CREATE TABLE phase_deliverables (
  id          bigserial PRIMARY KEY,
  project_id  text NOT NULL REFERENCES projects(id),
  phase_key   text NOT NULL,
  seq         int  NOT NULL DEFAULT 100,
  title       text NOT NULL,
  owner       text,
  due_on      date,
  status      text NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','in_progress','done','not_applicable')),
  evidence    text,
  file_id     uuid REFERENCES files(id),
  updated_by  uuid REFERENCES users(id),
  updated_at  timestamptz,
  FOREIGN KEY (project_id, phase_key) REFERENCES project_phases(project_id, key),
  CHECK (status NOT IN ('done','not_applicable') OR coalesce(length(evidence),0) >= 3)
);
CREATE INDEX ON phase_deliverables (project_id, phase_key);

CREATE TABLE project_updates (
  id         bigserial PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(id),
  phase_key  text,
  title      text NOT NULL,
  body       text NOT NULL,
  file_id    uuid REFERENCES files(id),
  public     boolean NOT NULL DEFAULT false,
  posted_by  uuid NOT NULL REFERENCES users(id),
  posted_at  timestamptz NOT NULL DEFAULT now()
);

-- Templates: phases and the standard deliverables for a school building project.
CREATE FUNCTION create_lifecycle(p text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO project_phases (project_id, key, seq, name, purpose, status) VALUES
    (p,'initiation', 1,'Initiation','Agree what we are building, why, where, and who is responsible.','in_progress'),
    (p,'planning',   2,'Planning & design','Design the building, cost it, get it approved and plan how to fund it.','not_started'),
    (p,'procurement',3,'Procurement','Choose a capable contractor fairly and sign the contract.','not_started'),
    (p,'execution',  4,'Execution','Build it: track progress, quality, cost and changes.','not_started'),
    (p,'closing',    5,'Closing & handover','Finish, fix defects, settle the final account and hand the block to PRESEC.','not_started')
  ON CONFLICT DO NOTHING;
  UPDATE project_phases SET actual_start = current_date WHERE project_id = p AND key = 'initiation' AND actual_start IS NULL;
  INSERT INTO phase_deliverables (project_id, phase_key, seq, title) VALUES
    (p,'initiation',1,'Letter of request / needs confirmation from PRESEC'),
    (p,'initiation',2,'Site identified and land ownership confirmed with the school'),
    (p,'initiation',3,'Project charter: objectives, scope, sponsor (approved by the committee)'),
    (p,'initiation',4,'Stakeholders identified: school, PTA, Old Students Association, year group'),
    (p,'initiation',5,'Project committee and roles appointed'),
    (p,'initiation',6,'Initial risk register'),
    (p,'planning',1,'Architectural and structural drawings'),
    (p,'planning',2,'Bill of quantities from the quantity surveyor'),
    (p,'planning',3,'Cost estimate and budget approved (member vote)'),
    (p,'planning',4,'Building permit from the Municipal Assembly'),
    (p,'planning',5,'Funding plan and fundraising targets'),
    (p,'planning',6,'Baseline schedule (programme of works)'),
    (p,'procurement',1,'Scope of works and tender documents'),
    (p,'procurement',2,'At least three bids received'),
    (p,'procurement',4,'Bid evaluation report'),
    (p,'procurement',5,'Contract award approved (member vote)'),
    (p,'procurement',6,'Contract signed and recorded'),
    (p,'execution',1,'Site handed over to the contractor (mobilisation)'),
    (p,'execution',2,'Work packages set up with weights totalling 100%'),
    (p,'execution',3,'Monthly progress reports'),
    (p,'execution',4,'Inspections at each construction stage'),
    (p,'execution',5,'QS payment certificates processed'),
    (p,'execution',6,'Variations approved before work is done'),
    (p,'closing',1,'Practical completion certificate'),
    (p,'closing',2,'Snag list cleared'),
    (p,'closing',3,'As-built drawings, manuals and warranties received'),
    (p,'closing',4,'Final account agreed with the contractor'),
    (p,'closing',5,'Handover ceremony and acceptance letter from PRESEC'),
    (p,'closing',6,'Retention released after the defects period'),
    (p,'closing',7,'Lessons-learned report to the year group');
END $$;

SELECT create_lifecycle(id) FROM projects;
