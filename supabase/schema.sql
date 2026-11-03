-- Synchronisation des données du site « Recettes & macros » : un compte par foyer.
-- À coller une fois dans Supabase : SQL Editor → New query → Run.
--
-- Une ligne par compte, avec les données du foyer en JSON (profils, recettes perso, favoris, planning…).
-- Les règles RLS garantissent qu'un compte ne lit et n'écrit que sa propre ligne, même avec la clé publique.

create table if not exists public.foyers (
  user_id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.foyers enable row level security;

drop policy if exists "foyer : lecture" on public.foyers;
drop policy if exists "foyer : création" on public.foyers;
drop policy if exists "foyer : mise à jour" on public.foyers;
drop policy if exists "foyer : suppression" on public.foyers;

create policy "foyer : lecture" on public.foyers
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "foyer : création" on public.foyers
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "foyer : mise à jour" on public.foyers
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "foyer : suppression" on public.foyers
  for delete to authenticated using ((select auth.uid()) = user_id);

-- Les visiteurs non connectés n'ont aucun accès.
revoke all on public.foyers from anon;
grant select, insert, update, delete on public.foyers to authenticated;
