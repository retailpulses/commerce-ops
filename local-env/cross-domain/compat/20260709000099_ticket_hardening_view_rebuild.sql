-- Local assembly compatibility step before Ticket MVP hardening.
-- The hardening migration replaces both derived views with incompatible
-- column names/order and therefore requires an explicit local drop.
drop view if exists public.ticket_list_view;
drop view if exists public.ticket_detail_view;
