create table if not exists public.users (
  id text primary key,
  name text not null,
  email text not null,
  phone text not null,
  password_hash text not null,
  password_salt text not null,
  created_at text not null
);
create unique index if not exists users_email_lower_unique on public.users (lower(email));
create unique index if not exists users_phone_unique on public.users (phone);

create table if not exists public.pending_registrations (
  email text primary key,
  name text not null,
  phone text not null unique,
  password_hash text not null,
  password_salt text not null,
  verification_hash text not null,
  attempts integer not null default 0,
  expires_at bigint not null,
  last_sent_at bigint not null
);

create table if not exists public.chats (
  id text primary key,
  type text not null check (type in ('direct', 'group', 'community', 'self')),
  name text,
  description text not null default '',
  created_by text not null references public.users(id),
  created_at text not null
);

create table if not exists public.chat_members (
  chat_id text not null references public.chats(id) on delete cascade,
  user_id text not null references public.users(id) on delete cascade,
  display_name text,
  primary key (chat_id, user_id)
);

create table if not exists public.messages (
  id text primary key,
  chat_id text not null references public.chats(id) on delete cascade,
  sender_id text not null references public.users(id),
  text text not null,
  attachment_name text,
  attachment_size text,
  created_at text not null
);

create table if not exists public.call_history (
  id text primary key,
  chat_id text not null references public.chats(id) on delete cascade,
  caller_id text not null references public.users(id),
  callee_id text not null references public.users(id),
  type text not null check (type in ('audio', 'video')),
  status text not null check (status in ('ringing', 'active', 'completed', 'missed', 'declined', 'cancelled')),
  created_at text not null,
  accepted_at text,
  ended_at text,
  duration_seconds integer not null default 0
);

create table if not exists public.contacts (
  owner_id text not null references public.users(id) on delete cascade,
  contact_id text not null references public.users(id) on delete cascade,
  display_name text not null,
  primary key (owner_id, contact_id),
  check (owner_id <> contact_id)
);

create table if not exists public.message_reports (
  id text primary key,
  chat_id text not null references public.chats(id) on delete cascade,
  message_id text not null references public.messages(id) on delete cascade,
  reporter_id text not null references public.users(id) on delete cascade,
  reason text not null,
  status text not null default 'open' check (status in ('open', 'resolved', 'dismissed')),
  created_at text not null,
  unique (message_id, reporter_id)
);

create table if not exists public.moderation_audit (
  id text primary key,
  report_id text not null,
  actor_id text not null,
  action text not null,
  created_at text not null
);

create table if not exists public.user_activity (
  id text primary key,
  user_id text references public.users(id) on delete set null,
  action text not null,
  details jsonb not null default '{}'::jsonb,
  created_at text not null
);

create table if not exists public.admin_access_log (
  id text primary key,
  action text not null,
  report_id text,
  created_at text not null
);

create table if not exists public.sessions (
  token_hash text primary key,
  user_id text references public.users(id) on delete cascade,
  role text not null,
  expires_at bigint not null
);

create index if not exists messages_chat_created on public.messages (chat_id, created_at);
create index if not exists call_history_chat_created on public.call_history (chat_id, created_at);
create index if not exists user_activity_created on public.user_activity (created_at);
create index if not exists user_activity_user_created on public.user_activity (user_id, created_at);
create index if not exists chat_members_user on public.chat_members (user_id, chat_id);
create index if not exists message_reports_status_created on public.message_reports (status, created_at);

alter table public.users enable row level security;
alter table public.pending_registrations enable row level security;
alter table public.chats enable row level security;
alter table public.chat_members enable row level security;
alter table public.messages enable row level security;
alter table public.call_history enable row level security;
alter table public.contacts enable row level security;
alter table public.message_reports enable row level security;
alter table public.moderation_audit enable row level security;
alter table public.user_activity enable row level security;
alter table public.admin_access_log enable row level security;
alter table public.sessions enable row level security;
