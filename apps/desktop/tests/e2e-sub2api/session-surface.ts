export interface ElectronSurfaceCandidate {
  readonly overlay: boolean
  readonly url: string
}

/** Identify the exact Host Session Surface without accepting same-origin console routes. */
export function isExpectedSessionSurface(
  candidate: ElectronSurfaceCandidate,
  expectedUrl?: string,
): boolean {
  if (candidate.overlay) return false
  if (expectedUrl === undefined) return true
  try {
    return new URL(candidate.url).href === new URL(expectedUrl).href
  } catch {
    return false
  }
}
