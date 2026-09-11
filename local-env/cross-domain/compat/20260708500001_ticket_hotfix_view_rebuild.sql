-- Local assembly compatibility step for ticket-handling's grandfathered
-- 0002_ticketing_hotfix_issue_types.sql.
--
-- PostgreSQL cannot CREATE OR REPLACE a view when a column is inserted before
-- existing columns. The owner migration assumes the two views were dropped in
-- its historical deployment path. Dropping only derived views here preserves
-- all table data and lets the unmodified owner migration recreate them.
drop view if exists public.ticket_list_view;
drop view if exists public.ticket_detail_view;
