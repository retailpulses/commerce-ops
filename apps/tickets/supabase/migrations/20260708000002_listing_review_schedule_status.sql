-- Listing Quality Engineering: editable schedule status.
--
-- Schedules live in listing_review_policies. This migration adds operator-visible
-- run status columns and a read-friendly Supabase view for checking schedules.

alter table listing_review_policies
  add column if not exists schedule_enabled boolean not null default true,
  add column if not exists schedule_timezone text not null default 'UTC',
  add column if not exists last_scheduled_at timestamptz,
  add column if not exists last_run_started_at timestamptz,
  add column if not exists last_run_completed_at timestamptz,
  add column if not exists last_run_status text,
  add column if not exists last_error_message text;

alter table listing_review_policies
  drop constraint if exists listing_review_policies_last_run_status_check;

alter table listing_review_policies
  add constraint listing_review_policies_last_run_status_check
  check (last_run_status is null or last_run_status in ('completed', 'failed', 'skipped'));

create index if not exists ix_review_policies_schedule
  on listing_review_policies(is_active, schedule_enabled, review_type, marketplace)
  where schedule_cron is not null;

drop view if exists listing_review_schedule_status_v1;

create view listing_review_schedule_status_v1 as
select
  p.id as policy_id,
  p.name,
  p.marketplace,
  p.review_type,
  p.scope_type,
  p.schedule_cron,
  p.schedule_timezone,
  p.schedule_enabled,
  p.is_active,
  p.qwen_enabled,
  p.priority,
  p.last_scheduled_at,
  p.last_run_started_at,
  p.last_run_completed_at,
  p.last_run_status,
  p.last_error_message,
  j.id as latest_job_id,
  j.status as latest_job_status,
  j.started_at as latest_job_started_at,
  j.completed_at as latest_job_completed_at,
  j.error_message as latest_job_error_message,
  r.id as latest_result_id,
  r.final_score as latest_final_score,
  r.image_score as latest_image_score,
  r.technical_score as latest_technical_score,
  r.created_at as latest_result_created_at
from listing_review_policies p
left join lateral (
  select *
  from listing_review_jobs j
  where j.trigger_policy_id = p.id
  order by j.created_at desc
  limit 1
) j on true
left join lateral (
  select *
  from listing_review_results r
  where r.job_id = j.id
  order by r.created_at desc
  limit 1
) r on true;

grant select on listing_review_schedule_status_v1 to anon;

grant select on listing_review_schedule_status_v1 to authenticated;

grant select on listing_review_schedule_status_v1 to service_role;
