-- Baserow contains two legitimate historical cases for one Mercari order.
-- Keep the one-ticket-per-order invariant for all active/new workflows while
-- allowing immutable migrated history to preserve both cases.

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
    RAISE EXCEPTION
      'duplicate active/new-workflow tickets must be reconciled before installing NULL-safe order uniqueness';
  END IF;
END $$;

DROP INDEX IF EXISTS public.idx_tickets_platform_order;
DROP INDEX IF EXISTS public.uq_tickets_platform_order;

CREATE UNIQUE INDEX idx_tickets_platform_order
  ON public.tickets (
    platform,
    COALESCE(account_id, '00000000-0000-0000-0000-000000000000'::uuid),
    external_order_id
  )
  WHERE external_order_id IS NOT NULL
    AND origin <> 'migrated_baserow';
