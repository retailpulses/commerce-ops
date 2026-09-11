-- Local assembly compatibility step before the Ticket product-name view fix.
-- The owner migration replaces incompatible derived view shapes.
drop view if exists public.ticket_list_view;
drop view if exists public.ticket_detail_view;
