export type DisplayFact = {
  statement: string; evidenceIds: string[]; reason: string;
};
export function partitionFacts(facts: unknown, scenario: {
  evidence?: unknown; analysis?: { sources?: unknown } | null;
}): { confirmed: DisplayFact[]; unconfirmed: DisplayFact[] };
