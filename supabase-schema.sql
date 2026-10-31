create table if not exists public.users (
  id text primary key,
  name text not null,
  email text not null,
  phone text not null,
  password_hash text not null,
  password_salt text not null,
  created_at timestamptz not null default now()
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
  created_at timestamptz not null default now()
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
  created_at timestamptz not null default now()
);

create table if not exists public.call_history (
  id text primary key,
  chat_id text not null references public.chats(id) on delete cascade,
  caller_id text not null references public.users(id),
  callee_id text not null references public.users(id),
  type text not null check (type in ('audio', 'video')),
  status text not null check (status in ('ringing', 'active', 'completed', 'missed', 'declined', 'cancelled')),
  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  ended_at timestamptz,
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
  created_at timestamptz not null default now(),
  unique (message_id, reporter_id)
);

create table if not exists public.moderation_audit (
  id text primary key,
  report_id text not null,
  actor_id text not null,
  action text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.user_activity (
  id text primary key,
  user_id text references public.users(id) on delete set null,
  action text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.admin_access_log (
  id text primary key,
  action text not null,
  report_id text,
  created_at timestamptz not null default now()
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

create or replace function public.chatter_render_statement(p_statement text, p_parameters jsonb)
returns text
language plpgsql
immutable
set search_path = pg_catalog, public
as $$
declare
  rendered text := p_statement;
  parameter_count integer;
  parameter_index integer;
  parameter_value jsonb;
  replacement text;
begin
  if p_statement !~* '^\s*(select|insert|update|delete)\s' or p_statement ~ ';|--|/\*|\*/' then
    raise exception 'Unsupported Chatter database statement';
  end if;
  if jsonb_typeof(p_parameters) <> 'array' then
    raise exception 'Chatter database parameters must be an array';
  end if;

  parameter_count := jsonb_array_length(p_parameters);
  if parameter_count > 0 then
    for parameter_index in reverse parameter_count..1 loop
      parameter_value := p_parameters -> (parameter_index - 1);
      case jsonb_typeof(parameter_value)
        when 'null' then replacement := 'NULL';
        when 'string' then replacement := quote_literal(parameter_value #>> '{}');
        when 'number' then replacement := parameter_value::text;
        when 'boolean' then replacement := parameter_value::text;
        when 'object' then replacement := quote_literal(parameter_value::text) || '::jsonb';
        when 'array' then replacement := quote_literal(parameter_value::text) || '::jsonb';
        else raise exception 'Unsupported Chatter database parameter';
      end case;
      rendered := replace(rendered, '$' || parameter_index, replacement);
    end loop;
  end if;

  if rendered ~ '\$\d+' then
    raise exception 'Chatter database statement has an unbound parameter';
  end if;
  return rendered;
end;
$$;

create or replace function public.chatter_query(p_statement text, p_parameters jsonb)
returns jsonb
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  rendered text;
  result_rows jsonb;
  affected_rows integer;
begin
  if coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'
  ) is distinct from 'service_role' then
    raise exception 'Chatter database API requires the server service role';
  end if;
  rendered := public.chatter_render_statement(p_statement, p_parameters);
  if rendered ~* '^\s*select\s' then
    execute 'select coalesce(jsonb_agg(to_jsonb(chatter_row)), ''[]''::jsonb) from (' || rendered || ') as chatter_row'
      into result_rows;
    return jsonb_build_object('rows', result_rows, 'rowCount', jsonb_array_length(result_rows));
  end if;
  execute rendered;
  get diagnostics affected_rows = row_count;
  return jsonb_build_object('rows', '[]'::jsonb, 'rowCount', affected_rows);
end;
$$;

create or replace function public.chatter_batch(p_statements jsonb)
returns jsonb
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  item jsonb;
  rendered text;
  affected_rows integer;
  total_affected integer := 0;
begin
  if coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'
  ) is distinct from 'service_role' then
    raise exception 'Chatter database API requires the server service role';
  end if;
  if jsonb_typeof(p_statements) <> 'array' then
    raise exception 'Chatter batch statements must be an array';
  end if;
  for item in select value from jsonb_array_elements(p_statements)
  loop
    rendered := public.chatter_render_statement(item ->> 'statement', item -> 'parameters');
    if rendered !~* '^\s*(insert|update|delete)\s' then
      raise exception 'Chatter batch only accepts data changes';
    end if;
    execute rendered;
    get diagnostics affected_rows = row_count;
    total_affected := total_affected + affected_rows;
  end loop;
  return jsonb_build_object('rowCount', total_affected);
end;
$$;

revoke all on function public.chatter_render_statement(text, jsonb) from public, anon, authenticated;
revoke all on function public.chatter_query(text, jsonb) from public, anon, authenticated;
revoke all on function public.chatter_batch(jsonb) from public, anon, authenticated;
grant execute on function public.chatter_render_statement(text, jsonb) to service_role;
grant execute on function public.chatter_query(text, jsonb) to service_role;
grant execute on function public.chatter_batch(jsonb) to service_role;
