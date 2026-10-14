-- While the platform has a single account (the founding administrator), give it the executive
-- committee role too, so set-up can be done before a committee exists. Runs once; no effect later.
INSERT INTO user_roles (user_id, role)
SELECT u.id, 'committee' FROM users u
WHERE (SELECT count(*) FROM users) = 1
  AND EXISTS (SELECT 1 FROM user_roles r WHERE r.user_id = u.id AND r.role = 'admin')
ON CONFLICT DO NOTHING;
