-- 기존 supabase-schema.sql을 이미 실행한 프로젝트에만 필요한 변경입니다.
-- 이번 입력 화면 작업에서는 원격 DB에 실행하지 않았습니다.
begin;
alter table public.classes add column if not exists friend_mode text
  check (friend_mode in ('together', 'apart', 'ignore'));
update public.classes
set friend_mode = case when respect_friend then 'together' else 'ignore' end
where friend_mode is null;
alter table public.classes alter column friend_mode set default 'together';
alter table public.classes alter column friend_mode set not null;
commit;
