-- =============================================================================
-- Cuota diaria por usuario.
--
-- Además del límite de preguntas de la organización, un plan puede limitar lo que
-- cada usuario gasta por día, para que una sola persona no agote el cupo de todos.
-- NULL = sin tope por usuario (solo rige el límite de la organización).
-- =============================================================================

ALTER TABLE plans ADD COLUMN user_daily_question_limit integer CHECK (user_daily_question_limit >= 1);
