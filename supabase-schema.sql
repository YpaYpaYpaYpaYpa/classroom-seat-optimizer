-- 새 DB / 기존 DB 모두 전체를 실행한다. 기존 학생·배치 기록은 보존한다.
-- 비밀번호는 이 테이블에 저장하지 않고 Supabase Auth가 관리한다.
begin;

create table if not exists public.classes (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null default '2학년 5반',
  group_count integer not null default 4 check (group_count between 1 and 60),
  group_columns integer not null default 3 check (group_columns between 1 and 60),
  score_mode text not null default 'balanced' check (score_mode in ('balanced', 'similar', 'ignore')),
  respect_friend boolean not null default true,
  friend_mode text not null default 'together' check (friend_mode in ('together', 'apart', 'ignore')),
  respect_vision boolean not null default true,
  avoid_previous boolean not null default false,
  revision bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, name)
);

alter table public.classes add column if not exists friend_mode text check (friend_mode in ('together', 'apart', 'ignore'));
update public.classes set friend_mode = case when respect_friend then 'together' else 'ignore' end where friend_mode is null;
alter table public.classes alter column friend_mode set default 'together';
alter table public.classes alter column friend_mode set not null;
alter table public.classes add column if not exists group_columns integer check (group_columns between 1 and 60);
update public.classes set group_columns = least(3, group_count) where group_columns is null;
alter table public.classes alter column group_columns set default 3;
alter table public.classes alter column group_columns set not null;
alter table public.classes add column if not exists revision bigint not null default 0;

create table if not exists public.students (
  id uuid primary key default gen_random_uuid(),
  class_id uuid not null references public.classes(id) on delete cascade,
  student_number text not null,
  score integer not null default 5 check (score between 1 and 10),
  vision_priority boolean not null default false,
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  unique (class_id, student_number)
);

create table if not exists public.student_relations (
  id uuid primary key default gen_random_uuid(),
  class_id uuid not null references public.classes(id) on delete cascade,
  first_student_id uuid not null references public.students(id) on delete cascade,
  second_student_id uuid not null references public.students(id) on delete cascade,
  relation_type text not null check (relation_type in ('friend', 'rival')),
  created_at timestamptz not null default now(),
  check (first_student_id <> second_student_id)
);

create table if not exists public.arrangement_runs (
  id uuid primary key default gen_random_uuid(),
  class_id uuid not null references public.classes(id) on delete cascade,
  group_count integer not null check (group_count between 1 and 60),
  settings jsonb not null default '{}'::jsonb,
  metrics jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.arrangement_assignments (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.arrangement_runs(id) on delete cascade,
  student_id uuid not null references public.students(id) on delete cascade,
  group_number integer not null check (group_number > 0),
  seat_index integer not null check (seat_index > 0),
  unique (run_id, student_id)
);

alter table public.classes enable row level security;
alter table public.students enable row level security;
alter table public.student_relations enable row level security;
alter table public.arrangement_runs enable row level security;
alter table public.arrangement_assignments enable row level security;

create index if not exists students_class_active_idx on public.students(class_id, is_active, sort_order);
create index if not exists relations_class_idx on public.student_relations(class_id);
create index if not exists runs_class_created_idx on public.arrangement_runs(class_id, created_at desc);
drop policy if exists "교사는 자기 학급만 조회" on public.classes;
drop policy if exists "교사는 자기 학급을 생성" on public.classes;
drop policy if exists "교사는 자기 학급만 수정" on public.classes;
drop policy if exists "교사는 자기 학급만 삭제" on public.classes;
drop policy if exists "교사는 자기 학생만 관리" on public.students;
drop policy if exists "교사는 자기 관계 데이터만 관리" on public.student_relations;
drop policy if exists "교사는 자기 배치 이력만 관리" on public.arrangement_runs;
drop policy if exists "교사는 자기 배치 결과만 관리" on public.arrangement_assignments;
create policy "교사는 자기 학급만 조회" on public.classes for select to authenticated using (owner_id = (select auth.uid()));
create policy "교사는 자기 학급을 생성" on public.classes for insert to authenticated with check (owner_id = (select auth.uid()));
create policy "교사는 자기 학급만 수정" on public.classes for update to authenticated using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy "교사는 자기 학급만 삭제" on public.classes for delete to authenticated using (owner_id = (select auth.uid()));

create policy "교사는 자기 학생만 관리" on public.students for all to authenticated
  using (exists (select 1 from public.classes c where c.id = class_id and c.owner_id = auth.uid()))
  with check (exists (select 1 from public.classes c where c.id = class_id and c.owner_id = auth.uid()));

create policy "교사는 자기 관계 데이터만 관리" on public.student_relations for all to authenticated
  using (exists (select 1 from public.classes c where c.id = class_id and c.owner_id = auth.uid()))
  with check (exists (select 1 from public.classes c where c.id = class_id and c.owner_id = auth.uid())
    and exists (select 1 from public.students s where s.id = first_student_id and s.class_id = student_relations.class_id)
    and exists (select 1 from public.students s where s.id = second_student_id and s.class_id = student_relations.class_id));

create policy "교사는 자기 배치 이력만 관리" on public.arrangement_runs for all to authenticated
  using (exists (select 1 from public.classes c where c.id = class_id and c.owner_id = auth.uid()))
  with check (exists (select 1 from public.classes c where c.id = class_id and c.owner_id = auth.uid()));

create policy "교사는 자기 배치 결과만 관리" on public.arrangement_assignments for all to authenticated
  using (exists (
    select 1 from public.arrangement_runs r
    join public.classes c on c.id = r.class_id
    where r.id = run_id and c.owner_id = auth.uid()
  ))
  with check (exists (
    select 1 from public.arrangement_runs r
    join public.classes c on c.id = r.class_id
    join public.students s on s.id = student_id and s.class_id = r.class_id
    where r.id = run_id and c.owner_id = auth.uid()
  ));

revoke all on public.classes, public.students, public.student_relations, public.arrangement_runs, public.arrangement_assignments from anon;
grant select, insert, update, delete on public.classes, public.students, public.student_relations, public.arrangement_runs, public.arrangement_assignments to authenticated;

-- Public health check contains no account or student data.
create or replace function public.classroom_backend_status() returns jsonb
language sql immutable security invoker set search_path = ''
as $$ select '{"schema_version":3}'::jsonb $$;

-- One read statement gives a consistent snapshot of the current user's class.
create or replace function public.load_classroom(p_owner_id uuid) returns jsonb
language plpgsql stable security invoker set search_path = ''
as $$
declare result jsonb;
begin
  if auth.uid() is null or auth.uid() <> p_owner_id or p_owner_id is null then
    raise exception 'CLASSROOM_OWNER_MISMATCH' using errcode = '42501';
  end if;
  select jsonb_build_object(
    'classroom', to_jsonb(c),
    'students', coalesce((select jsonb_agg(to_jsonb(s) order by s.sort_order, s.id)
      from public.students s where s.class_id = c.id and s.is_active), '[]'::jsonb),
    'relations', coalesce((select jsonb_agg(to_jsonb(r) order by r.id)
      from public.student_relations r
      join public.students a on a.id = r.first_student_id and a.class_id = c.id and a.is_active
      join public.students b on b.id = r.second_student_id and b.class_id = c.id and b.is_active
      where r.class_id = c.id), '[]'::jsonb)
  ) into result from public.classes c where c.owner_id = p_owner_id and c.name = '2학년 5반';
  return result;
end;
$$;

-- Replacing students, relations, settings and an optional result is one transaction.
-- An exception rolls everything back; no request accepts a client-selected different owner.
create or replace function public.save_classroom(p_owner_id uuid, p_snapshot jsonb, p_expected_revision bigint default null) returns jsonb
language plpgsql volatile security invoker set search_path = ''
as $$
declare
  v_class public.classes%rowtype;
  v_settings jsonb; v_students jsonb; v_relations jsonb; v_arrangement jsonb;
  v_count integer; v_groups integer; v_columns integer; v_run_id uuid;
begin
  if auth.uid() is null or auth.uid() <> p_owner_id or p_owner_id is null then
    raise exception 'CLASSROOM_OWNER_MISMATCH' using errcode = '42501';
  end if;
  if jsonb_typeof(p_snapshot) is distinct from 'object' or octet_length(p_snapshot::text) > 262144 then raise exception 'CLASSROOM_INVALID_INPUT'; end if;
  v_settings := p_snapshot->'settings'; v_students := p_snapshot->'students'; v_relations := p_snapshot->'relations';
  if jsonb_typeof(v_students) is distinct from 'array' or jsonb_typeof(v_relations) is distinct from 'array'
    or jsonb_typeof(v_settings) is distinct from 'object' then raise exception 'CLASSROOM_INVALID_INPUT'; end if;
  v_count := jsonb_array_length(v_students);
  if v_count not between 1 and 60 or jsonb_array_length(v_relations) > 1770 then raise exception 'CLASSROOM_INVALID_INPUT'; end if;
  if exists (select 1 from jsonb_array_elements(v_students) s where jsonb_typeof(s) is distinct from 'object'
    or jsonb_typeof(s->'id') is distinct from 'string' or coalesce(s->>'id', '') !~ '^[0-9]+$'
    or jsonb_typeof(s->'score') is distinct from 'number' or coalesce(s->>'score', '') !~ '^([1-9]|10)$'
    or jsonb_typeof(s->'vision') is distinct from 'boolean')
    or (select count(distinct s->>'id') from jsonb_array_elements(v_students) s) <> v_count then raise exception 'CLASSROOM_INVALID_INPUT'; end if;
  if jsonb_typeof(v_settings->'groupCount') is distinct from 'number' or coalesce(v_settings->>'groupCount', '') !~ '^([1-9]|[1-5][0-9]|60)$'
    or jsonb_typeof(v_settings->'groupColumns') is distinct from 'number' or coalesce(v_settings->>'groupColumns', '') !~ '^([1-9]|[1-5][0-9]|60)$'
    or coalesce(v_settings->>'scoreMode', '') not in ('balanced', 'similar', 'ignore')
    or coalesce(v_settings->>'friendMode', '') not in ('together', 'apart', 'ignore')
    or jsonb_typeof(v_settings->'respectVision') is distinct from 'boolean'
    or jsonb_typeof(v_settings->'avoidPrevious') is distinct from 'boolean' then raise exception 'CLASSROOM_INVALID_INPUT'; end if;
  v_groups := (v_settings->>'groupCount')::integer; v_columns := (v_settings->>'groupColumns')::integer;
  if v_groups > v_count or v_columns > v_groups then raise exception 'CLASSROOM_INVALID_INPUT'; end if;
  if exists (select 1 from jsonb_array_elements(v_relations) r where
    coalesce(r->>'type', '') not in ('friend', 'rival') or r->>'first' = r->>'second'
    or not exists (select 1 from jsonb_array_elements(v_students) s where s->>'id' = r->>'first')
    or not exists (select 1 from jsonb_array_elements(v_students) s where s->>'id' = r->>'second'))
    or exists (select 1 from jsonb_array_elements(v_relations) r
      group by least(r->>'first', r->>'second'), greatest(r->>'first', r->>'second') having count(*) > 1)
    or (v_groups = 1 and exists (select 1 from jsonb_array_elements(v_relations) r where r->>'type' = 'rival')) then raise exception 'CLASSROOM_INVALID_INPUT'; end if;

  perform pg_advisory_xact_lock(hashtextextended(p_owner_id::text, 0));
  select * into v_class from public.classes where owner_id = p_owner_id and name = '2학년 5반' for update;
  if found then
    if p_expected_revision is null then raise exception 'CLASSROOM_LOAD_REQUIRED' using errcode = 'PT409'; end if;
    if p_expected_revision <> v_class.revision then raise exception 'CLASSROOM_VERSION_CONFLICT' using errcode = 'PT409'; end if;
    update public.classes set group_count = v_groups, group_columns = v_columns,
      score_mode = v_settings->>'scoreMode', friend_mode = v_settings->>'friendMode', respect_friend = (v_settings->>'friendMode' <> 'ignore'),
      respect_vision = (v_settings->>'respectVision')::boolean, avoid_previous = (v_settings->>'avoidPrevious')::boolean,
      revision = revision + 1, updated_at = now() where id = v_class.id returning * into v_class;
  else
    if p_expected_revision is not null and p_expected_revision <> 0 then raise exception 'CLASSROOM_VERSION_CONFLICT' using errcode = 'PT409'; end if;
    insert into public.classes (owner_id, name, group_count, group_columns, score_mode, friend_mode, respect_friend, respect_vision, avoid_previous, revision)
    values (p_owner_id, '2학년 5반', v_groups, v_columns, v_settings->>'scoreMode', v_settings->>'friendMode', v_settings->>'friendMode' <> 'ignore',
      (v_settings->>'respectVision')::boolean, (v_settings->>'avoidPrevious')::boolean, 1) returning * into v_class;
  end if;
  update public.students set is_active = false where class_id = v_class.id;
  insert into public.students (class_id, student_number, score, vision_priority, sort_order, is_active)
    select v_class.id, s->>'id', (s->>'score')::integer, (s->>'vision')::boolean, ordinality - 1, true
    from jsonb_array_elements(v_students) with ordinality as items(s, ordinality)
    on conflict (class_id, student_number) do update set score = excluded.score, vision_priority = excluded.vision_priority,
      sort_order = excluded.sort_order, is_active = true;
  delete from public.student_relations where class_id = v_class.id;
  insert into public.student_relations (class_id, first_student_id, second_student_id, relation_type)
    select v_class.id, a.id, b.id, r->>'type' from jsonb_array_elements(v_relations) r
    join public.students a on a.class_id = v_class.id and a.student_number = r->>'first'
    join public.students b on b.class_id = v_class.id and b.student_number = r->>'second';

  v_arrangement := p_snapshot->'arrangement';
  if v_arrangement is not null and v_arrangement <> 'null'::jsonb then
    if jsonb_typeof(v_arrangement) is distinct from 'object' or jsonb_typeof(v_arrangement->'assignments') is distinct from 'array'
      or jsonb_typeof(v_arrangement->'metrics') is distinct from 'object' then raise exception 'CLASSROOM_INVALID_INPUT'; end if;
    if jsonb_array_length(v_arrangement->'assignments') <> v_count
      or exists (select 1 from jsonb_array_elements(v_arrangement->'assignments') a where
        coalesce(a->>'groupNumber', '') !~ '^([1-9]|[1-5][0-9]|60)$'
        or coalesce(a->>'seatIndex', '') !~ '^[1-9][0-9]{0,4}$'
        or not exists (select 1 from jsonb_array_elements(v_students) s where s->>'id' = a->>'studentNumber'))
      or (select count(distinct a->>'studentNumber') from jsonb_array_elements(v_arrangement->'assignments') a) <> v_count
      or (select count(distinct a->>'seatIndex') from jsonb_array_elements(v_arrangement->'assignments') a) <> v_count then raise exception 'CLASSROOM_INVALID_INPUT'; end if;
    if exists (select 1 from jsonb_array_elements(v_arrangement->'assignments') a where (a->>'groupNumber')::integer > v_groups)
      or (select count(distinct a->>'groupNumber') from jsonb_array_elements(v_arrangement->'assignments') a) <> v_groups
      or (select max(n) - min(n) from (select count(*) n from jsonb_array_elements(v_arrangement->'assignments') a group by a->>'groupNumber') sizes) > 1
      or exists (select 1 from jsonb_array_elements(v_relations) r
        join jsonb_array_elements(v_arrangement->'assignments') a on a->>'studentNumber' = r->>'first'
        join jsonb_array_elements(v_arrangement->'assignments') b on b->>'studentNumber' = r->>'second'
        where r->>'type' = 'rival' and a->>'groupNumber' = b->>'groupNumber') then raise exception 'CLASSROOM_INVALID_INPUT'; end if;
    insert into public.arrangement_runs (class_id, group_count, settings, metrics)
      values (v_class.id, v_groups, v_settings || jsonb_build_object('layout', v_arrangement->'layout'), v_arrangement->'metrics') returning id into v_run_id;
    insert into public.arrangement_assignments (run_id, student_id, group_number, seat_index)
      select v_run_id, s.id, (a->>'groupNumber')::integer, (a->>'seatIndex')::integer
      from jsonb_array_elements(v_arrangement->'assignments') a join public.students s on s.class_id = v_class.id and s.student_number = a->>'studentNumber';
  end if;
  return public.load_classroom(p_owner_id) || jsonb_build_object('run_id', v_run_id);
end;
$$;

revoke execute on function public.classroom_backend_status() from public, anon, authenticated;
revoke execute on function public.load_classroom(uuid) from public, anon, authenticated;
revoke execute on function public.save_classroom(uuid, jsonb, bigint) from public, anon, authenticated;
grant execute on function public.classroom_backend_status() to anon, authenticated;
grant execute on function public.load_classroom(uuid) to authenticated;
grant execute on function public.save_classroom(uuid, jsonb, bigint) to authenticated;
notify pgrst, 'reload schema';
commit;
