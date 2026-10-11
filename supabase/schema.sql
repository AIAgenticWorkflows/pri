-- Run once in Supabase: SQL Editor, New query, paste, Run.
-- One row per product or medicine a person saved. Nothing else about them is stored here;
-- their sign-in details live in Supabase Auth.

create table if not exists public.saved_items (
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  item_key   text not null check (char_length(item_key) <= 300),
  kind       text not null check (kind in ('grocery', 'medicine')),
  name       text not null check (char_length(name) <= 300),
  brand      text check (char_length(brand) <= 200),
  created_at timestamptz not null default now(),
  primary key (user_id, item_key)
);

alter table public.saved_items enable row level security;

-- Each person sees and changes only their own rows.
drop policy if exists "read own" on public.saved_items;
drop policy if exists "add own" on public.saved_items;
drop policy if exists "remove own" on public.saved_items;
create policy "read own"   on public.saved_items for select using (auth.uid() = user_id);
create policy "add own"    on public.saved_items for insert with check (auth.uid() = user_id);
create policy "remove own" on public.saved_items for delete using (auth.uid() = user_id);

-- A sensible ceiling per person.
create or replace function public.saved_items_limit() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if (select count(*) from public.saved_items where user_id = new.user_id) >= 500 then
    raise exception 'saved items limit reached';
  end if;
  return new;
end $$;
drop trigger if exists saved_items_limit on public.saved_items;
create trigger saved_items_limit before insert on public.saved_items for each row execute function public.saved_items_limit();
