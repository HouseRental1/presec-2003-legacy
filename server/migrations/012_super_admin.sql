-- Three access levels. Super admins hold the money approvals; admins run everything else and may record
-- (but not verify) payments; members are view-only.
ALTER TABLE user_roles DROP CONSTRAINT user_roles_role_check;
ALTER TABLE user_roles ADD CONSTRAINT user_roles_role_check
  CHECK (role IN ('superadmin','admin','officer','committee','treasurer','approver','auditor','pm','captain','member','school'));
-- Existing administrators (at launch: the founder) become super admins.
INSERT INTO user_roles (user_id, role)
SELECT ur.user_id, r FROM user_roles ur CROSS JOIN unnest(ARRAY['superadmin','officer','committee','treasurer','approver','pm']) r
WHERE ur.role = 'admin'
ON CONFLICT DO NOTHING;
UPDATE settings SET value='5' WHERE key='admin_cap' AND value='3';
