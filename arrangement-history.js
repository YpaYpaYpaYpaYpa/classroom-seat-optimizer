export function groupsFromSavedRun(run) {
  const groups = new Map();
  for (const assignment of run.arrangement_assignments ?? []) {
    const id = assignment.students?.student_number;
    if (!id || !Number.isInteger(assignment.group_number) || assignment.group_number < 1) continue;
    const members = groups.get(assignment.group_number) ?? [];
    members.push(id); groups.set(assignment.group_number, members);
  }
  return [...groups.values()];
}

export async function readSavedArrangements(client, userId, classId, signal) {
  if (!classId) {
    const { data, error } = await client.from('classes').select('id')
      .eq('owner_id', userId).eq('name', '2학년 5반').maybeSingle().abortSignal(signal);
    if (error) throw error;
    classId = data?.id;
  }
  if (!classId) return [];
  const { data, error } = await client.from('arrangement_runs')
    .select('id,arrangement_assignments(group_number,students(student_number))')
    .eq('class_id', classId).order('created_at', { ascending: false }).limit(20).abortSignal(signal);
  if (error) throw error;
  return (data ?? []).map(groupsFromSavedRun).filter(groups => groups.length);
}
