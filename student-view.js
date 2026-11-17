// The student-facing view receives only the layout and public student identifiers.
export function studentViewModel(result) {
  return {
    groupColumns: result.layout.groupColumns,
    seatColumns: result.layout.seatColumns,
    blockRows: result.layout.blockRows,
    groups: result.layout.groups.map(group => ({
      groupNumber: group.groupNumber,
      members: group.members.map(student => ({ id: student.id })),
    })),
  };
}
