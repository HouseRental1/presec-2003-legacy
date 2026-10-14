-- During set-up (single account), the founder also needs the project manager role to enter
-- work packages, risks and inspections. Runs once; no effect once others have joined.
INSERT INTO user_roles (user_id, role)
SELECT u.id, 'pm' FROM users u
WHERE (SELECT count(*) FROM users) = 1
  AND EXISTS (SELECT 1 FROM user_roles r WHERE r.user_id = u.id AND r.role = 'admin')
ON CONFLICT DO NOTHING;
