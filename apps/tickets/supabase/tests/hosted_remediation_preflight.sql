-- Read-only hosted release checks. Raise on any state that the remediation
-- migrations cannot reconcile safely.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.tickets
    WHERE external_order_id IS NOT NULL
      AND origin <> 'migrated_baserow'
    GROUP BY platform,
      COALESCE(account_id, '00000000-0000-0000-0000-000000000000'::uuid),
      external_order_id
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'duplicate active order groups require manual reconciliation';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.ticket_attachments
    GROUP BY storage_bucket, storage_path
    HAVING count(*) > 1 AND (
      bool_or(source <> 'imported_baserow')
      OR bool_or(storage_bucket NOT LIKE 'r2:%')
      OR count(DISTINCT ticket_id) > 1
      OR count(DISTINCT customer_submission_id) > 1
      OR count(DISTINCT COALESCE(original_url, '')) > 1
      OR count(DISTINCT COALESCE(filename, '')) > 1
      OR count(DISTINCT COALESCE(mime_type, '')) > 1
      OR count(DISTINCT media_type) > 1
      OR count(DISTINCT COALESCE(size_bytes, -1)) > 1
    )
  ) THEN
    RAISE EXCEPTION 'unsafe attachment path conflicts require manual reconciliation';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM storage.buckets
    WHERE id = 'ticket-attachments' AND public = false
  ) THEN
    RAISE EXCEPTION 'ticket-attachments bucket must exist and remain private';
  END IF;
END $$;

SELECT
  (SELECT count(*) FROM (
    SELECT 1 FROM public.ticket_attachments
    GROUP BY storage_bucket, storage_path HAVING count(*) > 1
  ) duplicate_paths) AS compatible_legacy_duplicate_paths,
  (SELECT file_size_limit FROM storage.buckets WHERE id = 'ticket-attachments')
    AS current_bucket_file_size_limit;
