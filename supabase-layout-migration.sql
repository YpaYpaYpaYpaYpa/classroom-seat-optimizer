-- 기존 classes 테이블이 있는 DB용 가로 열 수 설정 추가이다.
-- 로컬에 준비한 파일이며 원격 DB에는 실행하지 않았다.
begin;
alter table public.classes add column if not exists group_columns integer
  check (group_columns between 1 and 60);
update public.classes
set group_columns = least(3, group_count)
where group_columns is null;
alter table public.classes alter column group_columns set default 3;
alter table public.classes alter column group_columns set not null;
commit;
