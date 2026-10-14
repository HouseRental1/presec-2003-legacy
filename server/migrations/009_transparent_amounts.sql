-- The year group chose full transparency: every signed-in classmate sees what each classmate gave.
INSERT INTO settings (key, value) VALUES ('house_amounts', '"members"') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
