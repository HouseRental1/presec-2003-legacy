-- Two access levels: administrators hold the full admin bundle; members are view-only (plus pledging and paying).
INSERT INTO user_roles (user_id, role)
SELECT ur.user_id, r FROM user_roles ur CROSS JOIN unnest(ARRAY['committee','treasurer','approver','pm']) r
WHERE ur.role = 'admin'
ON CONFLICT DO NOTHING;
-- Member voting and event replies are off unless the administrators switch them on.
INSERT INTO settings (key, value) VALUES ('member_participation', 'false') ON CONFLICT (key) DO NOTHING;
