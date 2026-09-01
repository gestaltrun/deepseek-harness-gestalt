/**
 * Parse macOS `ipcs -ma` shared-memory rows.
 * @param {string} output - Command output.
 * @returns {Array<{ id: string, owner: string, attachments: number, size: number, creatorPid: number, lastPid: number }>} Parsed segments.
 */
export function parseDarwinSharedMemory(output) {
  return output.split(/\r?\n/u).flatMap((line) => {
    const fields = line.trim().split(/\s+/u)
    if (fields[0] !== 'm' || fields.length < 12) return []
    const attachments = Number(fields[8])
    const size = Number(fields[9])
    const creatorPid = Number(fields[10])
    const lastPid = Number(fields[11])
    if (![attachments, size, creatorPid, lastPid].every(Number.isSafeInteger)) return []
    return [{ id: fields[1], owner: fields[4], attachments, size, creatorPid, lastPid }]
  })
}

/**
 * Select PostgreSQL marker segments created during one run and no longer attached.
 * @param {Set<string>} baselineIds - Segment ids present before the run.
 * @param {ReturnType<typeof parseDarwinSharedMemory>} current - Segments present after process teardown.
 * @param {string} owner - Operating-system user that ran the test.
 * @param {Set<number>} ownedPids - PostgreSQL process ids recorded while owned processes were live.
 * @returns {string[]} Segment ids safe for the test runner to remove.
 */
export function newDetachedPostgresSegmentIds(baselineIds, current, owner, ownedPids) {
  return current
    .filter(segment => (
      !baselineIds.has(segment.id)
      && segment.owner === owner
      && segment.attachments === 0
      && segment.size === 56
      && (ownedPids.has(segment.creatorPid) || ownedPids.has(segment.lastPid))
    ))
    .map(segment => segment.id)
}
