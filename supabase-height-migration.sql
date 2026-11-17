-- 기존 데이터를 유지하며 키 고려 항목을 추가한다. 여러 번 실행할 수 있다.
begin;
alter table public.classes add column if not exists respect_height boolean not null default true;
alter table public.students add column if not exists height_priority boolean not null default false;

create or replace function public.classroom_backend_status() returns jsonb
language sql immutable security invoker set search_path = ''
as $$ select '{"schema_version":3,"height_supported":true}'::jsonb $$;

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
    or jsonb_typeof(s->'vision') is distinct from 'boolean'
    or (s ? 'height' and jsonb_typeof(s->'height') is distinct from 'boolean'))
    or (select count(distinct s->>'id') from jsonb_array_elements(v_students) s) <> v_count then raise exception 'CLASSROOM_INVALID_INPUT'; end if;
  if jsonb_typeof(v_settings->'groupCount') is distinct from 'number' or coalesce(v_settings->>'groupCount', '') !~ '^([1-9]|[1-5][0-9]|60)$'
    or jsonb_typeof(v_settings->'groupColumns') is distinct from 'number' or coalesce(v_settings->>'groupColumns', '') !~ '^([1-9]|[1-5][0-9]|60)$'
    or coalesce(v_settings->>'scoreMode', '') not in ('balanced', 'similar', 'ignore')
    or coalesce(v_settings->>'friendMode', '') not in ('together', 'apart', 'ignore')
    or jsonb_typeof(v_settings->'respectVision') is distinct from 'boolean'
    or (v_settings ? 'respectHeight' and jsonb_typeof(v_settings->'respectHeight') is distinct from 'boolean')
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
      respect_vision = (v_settings->>'respectVision')::boolean, respect_height = coalesce((v_settings->>'respectHeight')::boolean, respect_height),
      avoid_previous = (v_settings->>'avoidPrevious')::boolean,
      revision = revision + 1, updated_at = now() where id = v_class.id returning * into v_class;
  else
    if p_expected_revision is not null and p_expected_revision <> 0 then raise exception 'CLASSROOM_VERSION_CONFLICT' using errcode = 'PT409'; end if;
    insert into public.classes (owner_id, name, group_count, group_columns, score_mode, friend_mode, respect_friend, respect_vision, respect_height, avoid_previous, revision)
    values (p_owner_id, '2학년 5반', v_groups, v_columns, v_settings->>'scoreMode', v_settings->>'friendMode', v_settings->>'friendMode' <> 'ignore',
      (v_settings->>'respectVision')::boolean, coalesce((v_settings->>'respectHeight')::boolean, true), (v_settings->>'avoidPrevious')::boolean, 1) returning * into v_class;
  end if;
  update public.students set is_active = false where class_id = v_class.id;
  insert into public.students (class_id, student_number, score, vision_priority, height_priority, sort_order, is_active)
    select v_class.id, s->>'id', (s->>'score')::integer, (s->>'vision')::boolean, coalesce((s->>'height')::boolean, false), ordinality - 1, true
    from jsonb_array_elements(v_students) with ordinality as items(s, ordinality)
    on conflict (class_id, student_number) do update set score = excluded.score, vision_priority = excluded.vision_priority,
      height_priority = case when exists (select 1 from jsonb_array_elements(v_students) item where item->>'id' = excluded.student_number and item ? 'height')
        then excluded.height_priority else students.height_priority end,
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

notify pgrst, 'reload schema';
commit;
