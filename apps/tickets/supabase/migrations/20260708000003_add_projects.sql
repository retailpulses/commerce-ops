-- Project Management MVP: projects and project_attachments tables
-- Dependencies: tasks table (created in 20260702000000)

create table if not exists projects (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  status text not null default 'active',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint projects_status_check check (
    status in ('active', 'paused', 'completed', 'archived')
  )
);

drop trigger if exists set_projects_updated_at on projects;

create trigger set_projects_updated_at
  before update on projects
  for each row execute function set_updated_at();

create index if not exists idx_projects_status on projects(status);

create table if not exists project_attachments (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  file_name text not null,
  content_type text not null,
  file_size_bytes integer not null,
  file_data_url text not null,
  uploaded_by text not null default 'jim',
  description text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint project_attachments_uploaded_by_check check (
    uploaded_by in ('jim', 'system', 'agent')
  ),
  constraint project_attachments_file_size_check check (
    file_size_bytes > 0 and file_size_bytes <= 5242880
  )
);

create index if not exists idx_project_attachments_project_created
  on project_attachments(project_id, created_at);

-- Add project_id to tasks (soft link: set null on project delete)
alter table tasks
  add column if not exists project_id uuid
  references projects(id) on delete set null;

create index if not exists idx_tasks_project_id on tasks(project_id);

-- Grant MVP access matching the existing task table posture.
-- RLS/auth is deferred for the local/manual MVP.
grant all on projects to service_role;

grant all on project_attachments to service_role;

grant select, insert, update, delete on projects to anon, authenticated;

grant select, insert, update, delete on project_attachments to anon, authenticated;
