/**
 * POST-MERGE FINDINGS (backlog 59): the closed list of a finding's categories and their
 * words. Dependency-free on purpose: the CLI's command module reads the labels at help
 * time, before anything heavy loads (services/findingService.ts re-exports them).
 */
export const FINDING_CATEGORIES = [
  "missed_requirement",
  "wrong_assumption",
  "test_gap",
  "convention",
  "other",
] as const;
export type FindingCategory = (typeof FINDING_CATEGORIES)[number];

export const FINDING_CATEGORY_LABEL: Record<FindingCategory, string> = {
  missed_requirement: "missed requirement",
  wrong_assumption: "wrong assumption",
  test_gap: "test gap",
  convention: "convention",
  other: "other",
};
