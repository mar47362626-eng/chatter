create table if not exists public.users (
  id text primary key,
  name text not null,
  email text not null,
  phone text not null,
  avatar_path text,
  share_token text,
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

create table if not exists public.pending_profile_updates (
  user_id text primary key references public.users(id) on delete cascade,
  email text not null unique,
  name text not null,
  phone text not null,
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
  attachment_path text,
  attachment_mime text,
  created_at timestamptz not null default now()
);

create table if not exists public.statuses (
  id text primary key,
  user_id text not null references public.users(id) on delete cascade,
  text text not null default '',
  attachment_path text,
  attachment_mime text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create table if not exists public.push_subscriptions (
  id text primary key,
  user_id text not null references public.users(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.data_plans (
  id text primary key,
  name text not null,
  amount integer not null default 0 check (amount >= 0),
  currency text not null default 'NGN' check (currency = 'NGN'),
  data_limit_bytes bigint not null check (data_limit_bytes >= 0),
  overage_price_per_gb integer not null default 200 check (overage_price_per_gb >= 0),
  is_default boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.user_data_subscriptions (
  id text primary key,
  user_id text not null references public.users(id) on delete cascade,
  plan_id text not null references public.data_plans(id) on delete restrict,
  status text not null default 'active' check (status in ('active', 'expired', 'cancelled')),
  monthly_limit_bytes bigint not null check (monthly_limit_bytes >= 0),
  monthly_used_bytes bigint not null default 0 check (monthly_used_bytes >= 0),
  period_starts_at timestamptz not null default now(),
  period_ends_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.data_usage (
  id text primary key,
  user_id text not null references public.users(id) on delete cascade,
  bytes_used bigint not null check (bytes_used > 0),
  category text not null check (category in ('message', 'image', 'video', 'file', 'call')),
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

create table if not exists public.test_payment_transactions (
  reference text primary key,
  user_id text not null references public.users(id) on delete cascade,
  customer_email text not null,
  amount integer not null check (amount = 10000),
  currency text not null check (currency = 'NGN'),
  status text not null default 'pending' check (status in ('pending', 'success')),
  created_at timestamptz not null default now(),
  verified_at timestamptz
);

create table if not exists public.foreign_numbers (
  id text primary key,
  phone text not null unique check (phone ~ '^\+[1-9][0-9]{6,14}$'),
  country text not null,
  status text not null default 'available' check (status in ('available', 'reserved', 'assigned')),
  assigned_user_id text references public.users(id) on delete set null,
  reserved_user_id text references public.users(id) on delete set null,
  reserved_until timestamptz,
  created_at timestamptz not null default now(),
  check ((status = 'assigned') = (assigned_user_id is not null))
);

alter table public.foreign_numbers
  add column if not exists reserved_user_id text references public.users(id) on delete set null;

create table if not exists public.number_subscriptions (
  id text primary key,
  user_id text not null references public.users(id) on delete cascade,
  number_id text not null references public.foreign_numbers(id),
  reference text not null unique,
  paystack_subscription_code text unique,
  paystack_email_token text,
  status text not null default 'pending' check (status in ('pending', 'pending_approval', 'active', 'past_due', 'cancelled', 'ended', 'expired', 'rejected')),
  cancel_at_period_end boolean not null default false,
  amount integer not null check (amount = 1000000),
  currency text not null check (currency = 'NGN'),
  next_payment_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.number_subscriptions
  drop constraint if exists number_subscriptions_status_check;
alter table public.number_subscriptions
  add constraint number_subscriptions_status_check
  check (status in ('pending', 'pending_approval', 'active', 'past_due', 'cancelled', 'ended', 'expired', 'rejected'));

create table if not exists public.number_subscription_payments (
  reference text primary key,
  subscription_id text not null references public.number_subscriptions(id) on delete cascade,
  amount integer not null check (amount = 1000000),
  currency text not null check (currency = 'NGN'),
  status text not null check (status in ('success', 'failed')),
  paid_at timestamptz,
  created_at timestamptz not null default now()
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
create index if not exists statuses_expires_at on public.statuses (expires_at);
create index if not exists statuses_user_created on public.statuses (user_id, created_at desc);
create index if not exists push_subscriptions_user on public.push_subscriptions (user_id);
create index if not exists data_plans_default on public.data_plans (is_default);
create index if not exists user_data_subscriptions_user_status on public.user_data_subscriptions (user_id, status, period_ends_at);
create index if not exists data_usage_user_created on public.data_usage (user_id, created_at);
create index if not exists call_history_chat_created on public.call_history (chat_id, created_at);
create index if not exists user_activity_created on public.user_activity (created_at);
create index if not exists user_activity_user_created on public.user_activity (user_id, created_at);
create index if not exists chat_members_user on public.chat_members (user_id, chat_id);
create index if not exists message_reports_status_created on public.message_reports (status, created_at);

alter table public.users enable row level security;
alter table public.pending_registrations enable row level security;
alter table public.pending_profile_updates enable row level security;
alter table public.chats enable row level security;
alter table public.chat_members enable row level security;
alter table public.messages enable row level security;
alter table public.statuses enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.data_plans enable row level security;
alter table public.user_data_subscriptions enable row level security;
alter table public.data_usage enable row level security;
alter table public.call_history enable row level security;
alter table public.contacts enable row level security;
alter table public.message_reports enable row level security;
alter table public.moderation_audit enable row level security;
alter table public.user_activity enable row level security;
alter table public.admin_access_log enable row level security;
alter table public.sessions enable row level security;
alter table public.foreign_numbers enable row level security;
alter table public.number_subscriptions enable row level security;
alter table public.number_subscription_payments enable row level security;

-- Default deny for direct client requests. The Node backend uses the service-role key,
-- so it bypasses these checks. Honest clients can only access their own rows.
create policy "users_select_own" on public.users for select using (auth.uid() = id);
create policy "users_update_own" on public.users for update using (auth.uid() = id) with check (auth.uid() = id);
create policy "users_insert_blocked" on public.users for insert with check (false);
create policy "users_delete_blocked" on public.users for delete using (false);

create policy "pending_registrations_owner_only" on public.pending_registrations for all using (auth.uid() is not null and auth.uid() = (select id from public.users where email = pending_registrations.email) and auth.uid() is not null) with check (false);
create policy "pending_profile_updates_owner_only" on public.pending_profile_updates for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "chats_read_members_only" on public.chats for select using (
  exists (
    select 1 from public.chat_members cm
    where cm.chat_id = chats.id and cm.user_id = auth.uid()
  )
);
create policy "chats_insert_member_only" on public.chats for insert with check (auth.uid() = created_by);
create policy "chats_update_owner_only" on public.chats for update using (auth.uid() = created_by) with check (auth.uid() = created_by);
create policy "chats_delete_owner_only" on public.chats for delete using (auth.uid() = created_by);

create policy "chat_members_select_own" on public.chat_members for select using (user_id = auth.uid());
create policy "chat_members_insert_member_only" on public.chat_members for insert with check (user_id = auth.uid());
create policy "chat_members_update_own" on public.chat_members for update using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "chat_members_delete_own" on public.chat_members for delete using (user_id = auth.uid());

create policy "messages_read_members_only" on public.messages for select using (
  exists (
    select 1 from public.chat_members cm
    where cm.chat_id = messages.chat_id and cm.user_id = auth.uid()
  )
);
create policy "messages_insert_member_only" on public.messages for insert with check (
  auth.uid() = sender_id and exists (
    select 1 from public.chat_members cm
    where cm.chat_id = messages.chat_id and cm.user_id = auth.uid()
  )
);
create policy "messages_update_own" on public.messages for update using (auth.uid() = sender_id) with check (auth.uid() = sender_id);
create policy "messages_delete_own" on public.messages for delete using (auth.uid() = sender_id);

create policy "statuses_read_public_or_owner" on public.statuses for select using (
  auth.uid() = user_id or exists (
    select 1 from public.contacts c
    where c.owner_id = auth.uid() and c.contact_id = statuses.user_id
  )
);
create policy "statuses_insert_own" on public.statuses for insert with check (auth.uid() = user_id);
create policy "statuses_update_own" on public.statuses for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "statuses_delete_own" on public.statuses for delete using (auth.uid() = user_id);

create policy "push_subscriptions_select_own" on public.push_subscriptions for select using (auth.uid() = user_id);
create policy "push_subscriptions_insert_own" on public.push_subscriptions for insert with check (auth.uid() = user_id);
create policy "push_subscriptions_update_own" on public.push_subscriptions for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "push_subscriptions_delete_own" on public.push_subscriptions for delete using (auth.uid() = user_id);

create policy "data_plans_read_public" on public.data_plans for select using (true);
create policy "data_plans_block_client_write" on public.data_plans for all using (false) with check (false);

create policy "subscription_select_own" on public.user_data_subscriptions for select using (auth.uid() = user_id);
create policy "subscription_manage_own" on public.user_data_subscriptions for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "usage_select_own" on public.data_usage for select using (auth.uid() = user_id);
create policy "usage_insert_own" on public.data_usage for insert with check (auth.uid() = user_id);
create policy "usage_delete_own" on public.data_usage for delete using (auth.uid() = user_id);

create policy "call_history_select_participant" on public.call_history for select using (
  auth.uid() = caller_id or auth.uid() = callee_id
);
create policy "call_history_insert_participant" on public.call_history for insert with check (
  auth.uid() = caller_id or auth.uid() = callee_id
);
create policy "call_history_update_participant" on public.call_history for update using (
  auth.uid() = caller_id or auth.uid() = callee_id
) with check (auth.uid() = caller_id or auth.uid() = callee_id);
create policy "call_history_delete_participant" on public.call_history for delete using (
  auth.uid() = caller_id or auth.uid() = callee_id
);

create policy "contacts_select_own" on public.contacts for select using (auth.uid() = owner_id);
create policy "contacts_manage_own" on public.contacts for all using (auth.uid() = owner_id) with check (auth.uid() = owner_id);

create policy "reports_select_own" on public.message_reports for select using (
  auth.uid() = reporter_id or exists (
    select 1 from public.chat_members cm
    where cm.chat_id = message_reports.chat_id and cm.user_id = auth.uid()
  )
);
create policy "reports_insert_own" on public.message_reports for insert with check (
  auth.uid() = reporter_id and exists (
    select 1 from public.chat_members cm
    where cm.chat_id = message_reports.chat_id and cm.user_id = auth.uid()
  )
);
create policy "reports_update_moderator_only" on public.message_reports for update using (false) with check (false);

create policy "audit_read_auth" on public.moderation_audit for select using (auth.uid() = actor_id);
create policy "audit_block_client_write" on public.moderation_audit for all using (false) with check (false);

create policy "user_activity_select_own" on public.user_activity for select using (auth.uid() = user_id);
create policy "user_activity_insert_own" on public.user_activity for insert with check (auth.uid() = user_id);
create policy "user_activity_block_updates" on public.user_activity for update using (false) with check (false);
create policy "user_activity_delete_own" on public.user_activity for delete using (auth.uid() = user_id);

create policy "admin_log_block_client" on public.admin_access_log for all using (false) with check (false);

create policy "sessions_select_own" on public.sessions for select using (auth.uid() = user_id);
create policy "sessions_insert_own" on public.sessions for insert with check (auth.uid() = user_id);
create policy "sessions_update_own" on public.sessions for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "sessions_delete_own" on public.sessions for delete using (auth.uid() = user_id);

create policy "foreign_numbers_read_available" on public.foreign_numbers for select using (true);
create policy "foreign_numbers_block_client_write" on public.foreign_numbers for all using (false) with check (false);

create policy "number_subscriptions_select_own" on public.number_subscriptions for select using (auth.uid() = user_id);
create policy "number_subscriptions_manage_own" on public.number_subscriptions for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "number_subscription_payments_select_own" on public.number_subscription_payments for select using (
  exists (
    select 1 from public.number_subscriptions ns
    where ns.id = number_subscription_payments.subscription_id and ns.user_id = auth.uid()
  )
);
create policy "number_subscription_payments_block_client_write" on public.number_subscription_payments for all using (false) with check (false);

create index if not exists foreign_numbers_status_created on public.foreign_numbers (status, created_at);
create index if not exists number_subscriptions_user_status on public.number_subscriptions (user_id, status);
create index if not exists number_subscriptions_renewal on public.number_subscriptions (status, next_payment_at);
drop index if exists public.number_subscriptions_one_current_per_user;
drop index if exists public.number_subscriptions_one_current_per_number;
create unique index if not exists number_subscriptions_one_current_per_user
  on public.number_subscriptions (user_id) where status in ('pending', 'pending_approval', 'active', 'past_due');
create unique index if not exists number_subscriptions_one_current_per_number
  on public.number_subscriptions (number_id) where status in ('pending', 'pending_approval', 'active', 'past_due');

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

alter table public.users add column if not exists avatar_path text;
alter table public.users add column if not exists share_token text;
alter table public.messages add column if not exists attachment_path text;
alter table public.messages add column if not exists attachment_mime text;

update public.users
set share_token = substr(md5(gen_random_uuid()::text), 1, 16)
  || substr(md5(gen_random_uuid()::text), 1, 16)
  || substr(md5(gen_random_uuid()::text), 1, 16)
where share_token is null;
alter table public.users alter column share_token set not null;
create unique index if not exists users_share_token_unique on public.users (share_token);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'chatter-media',
  'chatter-media',
  false,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;
