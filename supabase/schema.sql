-- Run once in Supabase: SQL Editor, New query, paste, Run. Safe to run again.
-- Each person's shopping lists. Nothing else about them is stored here; their sign-in
-- details live in Supabase Auth, and everything below goes when the account is deleted.

create table if not exists public.lists (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name       text not null check (char_length(name) between 1 and 60),
  created_at timestamptz not null default now()
);
create index if not exists lists_user on public.lists (user_id);

create table if not exists public.list_items (
  list_id    uuid not null references public.lists (id) on delete cascade,
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  item_key   text not null check (char_length(item_key) <= 300),
  kind       text not null check (kind in ('grocery', 'medicine')),
  name       text not null check (char_length(name) <= 300),
  brand      text check (char_length(brand) <= 200),
  qty        integer not null default 1 check (qty between 1 and 99),
  created_at timestamptz not null default now(),
  primary key (list_id, item_key)
);
create index if not exists list_items_user on public.list_items (user_id);

alter table public.lists enable row level security;
alter table public.list_items enable row level security;

-- Each person sees and changes only their own lists and the items in them.
drop policy if exists "own lists" on public.lists;
create policy "own lists" on public.lists for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own list items" on public.list_items;
create policy "own list items" on public.list_items for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id and exists (select 1 from public.lists l where l.id = list_id and l.user_id = auth.uid()));

-- Sensible ceilings: 30 lists per person, 200 products per list.
create or replace function public.lists_limit() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if (select count(*) from public.lists where user_id = new.user_id) >= 30 then raise exception 'lists limit reached'; end if;
  return new;
end $$;
drop trigger if exists lists_limit on public.lists;
create trigger lists_limit before insert on public.lists for each row execute function public.lists_limit();

create or replace function public.list_items_limit() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if (select count(*) from public.list_items where list_id = new.list_id) >= 200 then raise exception 'list items limit reached'; end if;
  return new;
end $$;
drop trigger if exists list_items_limit on public.list_items;
create trigger list_items_limit before insert on public.list_items for each row execute function public.list_items_limit();

-- The earlier "saved items" table is no longer used.
drop table if exists public.saved_items;
