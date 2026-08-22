// Vendored stub: upstream shipped 1231 lines of dashboard mock generators
// (dev-only `?mock=1` mode). The embedded dashboard always talks to the real
// local server, so mock mode is compiled out; api.ts has no mock branches.
export function isMockEnabled(): boolean {
  return false;
}

export function getMockNow(): Date | null {
  return null;
}
