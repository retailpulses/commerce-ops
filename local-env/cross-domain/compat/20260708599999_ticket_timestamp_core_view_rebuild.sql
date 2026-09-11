-- Local assembly compatibility step between the grandfathered Ticket schema
-- and 20260709000000_ticketing_mvp_core.sql.
--
-- The timestamped core changes both view shape and column count. PostgreSQL
-- requires derived views to be dropped before the unmodified owner migration
-- recreates them. No owner table or data is changed here.
drop view if exists public.ticket_list_view;
drop view if exists public.ticket_detail_view;
