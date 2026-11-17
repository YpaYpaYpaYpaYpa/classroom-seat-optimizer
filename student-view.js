// Include only the layout, student IDs, and enabled seating indicators.
export function studentViewModel(result, settings) {
  return {
    groupColumns: result.layout.groupColumns,
    seatColumns: result.layout.seatColumns,
    blockRows: result.layout.blockRows,
    groups: result.layout.groups.map(group => ({
      groupNumber: group.groupNumber,
      members: group.members.map(student => ({
        id: student.id,
        vision: Boolean(settings.respectVision && student.vision),
        height: Boolean(settings.respectHeight && student.height),
      })),
    })),
  };
}
