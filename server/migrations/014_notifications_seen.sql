-- Unread notification count: when each person last opened their notifications.
ALTER TABLE users ADD COLUMN notifications_seen_at timestamptz;
