-- A fourth job status: 'cancelling' (roadmap M15).
--
-- `/level reward backfill` can run for a long time over a large guild, so an
-- admin has to be able to stop one. The cancel signal has to be visible to
-- whatever process is executing the run — which may not be the process that
-- received the button press — so it cannot be an in-memory flag; it is the
-- claim row's own status, which the run re-reads at every member boundary.
--
-- Deliberately a distinct status rather than an early 'failed': a cancelled run
-- did exactly what it was told, and a health report that counts it as a failure
-- teaches admins to ignore failures.

ALTER TABLE job_run DROP CONSTRAINT job_run_status_check;

ALTER TABLE job_run
  ADD CONSTRAINT job_run_status_check
  CHECK (status IN ('running', 'cancelling', 'succeeded', 'failed'));
