-- The conflict-of-interest register is no longer part of the app; drop its procurement checklist item
-- (only where it has not been worked on) and from the template for new projects.
DELETE FROM phase_deliverables
 WHERE phase_key = 'procurement' AND title = 'Conflict-of-interest declarations from evaluators' AND status = 'todo';
