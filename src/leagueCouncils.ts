export const stateCouncils = ["NSWPC", "SQPC", "VTPC", "SAPC", "WAPC", "NTPC", "NQPC"];

// Queensland has two councils, so an old QLD preference needs a fresh choice.
export function councilFromLegacyRegion(region: string): string {
  if (stateCouncils.includes(region)) return region;
  return ({ ACT: "NSWPC", NSW: "NSWPC", VIC: "VTPC", SA: "SAPC", WA: "WAPC", NT: "NTPC" } as Record<string,string>)[region] ?? "";
}
