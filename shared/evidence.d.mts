import type { Evidence, Scenario } from '../src/types';
export function enabledEvidence(scenario: Pick<Scenario, 'evidence'>): Evidence[];
export function evidenceBody(item: Evidence): string;
export function inferEvidenceTitle(title?: string, text?: string, originalName?: string): string;
export function evidenceUsage(scenario: Pick<Scenario, 'evidence' | 'synopsis' | 'roleProfile'>, includeRoleProfile?: boolean): {
  count: number; textCharacters: number; attachmentBytes: number; retainedBytes: number;
};
