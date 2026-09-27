export type SelectionToken = { id: string | null; generation: number };
export type SelectionGuard = {
  select(id: string | null): SelectionToken;
  capture(): SelectionToken;
  isCurrent(token: SelectionToken): boolean;
  canApply<T extends { id: string; revision: number }>(token: SelectionToken, next: T, displayed: T | null): boolean;
};
export function createSelectionGuard(): SelectionGuard;
