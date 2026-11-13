export const leagueCategories = [
  { value: "beginner", label: "Beginner", description: "Suits smaller than an ATC/Strix." },
  { value: "intermediate", label: "Intermediate", description: "Non-race/non-competition suits." },
  { value: "open", label: "Open", description: "Experienced competitors in race/competition suits." },
] as const;
export type LeagueCategory = typeof leagueCategories[number]["value"];
export const categoryLabel = (value: string | undefined) =>
  leagueCategories.find(category => category.value === (value ?? "open"))?.label ?? value;
