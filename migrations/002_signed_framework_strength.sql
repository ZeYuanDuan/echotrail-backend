ALTER TABLE framework_signals
  DROP CONSTRAINT framework_signals_strength_check;

ALTER TABLE framework_signals
  ADD CONSTRAINT framework_signals_strength_check
  CHECK (strength BETWEEN -10 AND 10 AND strength <> 0);
