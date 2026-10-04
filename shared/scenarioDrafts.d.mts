import type { Evidence, Scenario, Visibility } from '../src/types';

export type DraftSource = Pick<Scenario, 'id' | 'revision' | 'title' | 'synopsis'> & Partial<Pick<Scenario, 'roleProfile'>>;
export type TextDraft = { title: string; text: string; visibility: Visibility };
export type ProfileDraft = { title: string; synopsis: string; role: string; goal: string; secret: string };
export type DraftCandidate = { id: string; type: 'file' | 'image'; name: string; byteSize: number; token?: string; dataUrl?: string; loading?: boolean; error?: string };
export type EvidenceEdit = { title: string; text: string; expectedUpdatedAt: string };
export type DraftSave<T> = { readonly id: string; readonly version: number; readonly value: Readonly<T> };
export type ScenarioDrafts = {
  read(scenario: DraftSource): { text: TextDraft; candidates: DraftCandidate[]; profile: ProfileDraft; textSaving: boolean; profileSaving: boolean };
  editText(scenario: DraftSource, patch: Partial<TextDraft>): void;
  editProfile(scenario: DraftSource, profile: ProfileDraft): void;
  appendCandidates(scenario: DraftSource, candidates: DraftCandidate[]): void;
  updateCandidate(scenario: DraftSource, id: string, patch: Partial<DraftCandidate>): void;
  removeCandidate(scenario: DraftSource, id: string): boolean;
  readEvidence(scenario: DraftSource, item: Evidence): EvidenceEdit & { saving: boolean };
  editEvidence(scenario: DraftSource, item: Evidence, patch: Partial<EvidenceEdit>): void;
  beginEvidenceSave(scenario: DraftSource, item: Evidence): (DraftSave<EvidenceEdit> & { evidenceId: string }) | null;
  finishEvidenceSave(request: DraftSave<EvidenceEdit> & { evidenceId: string }, saved: Scenario | null): void;
  beginTextSave(scenario: DraftSource): (DraftSave<TextDraft> & { candidates: DraftCandidate[] }) | null;
  finishTextSave(request: DraftSave<TextDraft> & { candidates: DraftCandidate[] }, saved: DraftSource | null): void;
  beginProfileSave(scenario: DraftSource): DraftSave<ProfileDraft> | null;
  finishProfileSave(request: DraftSave<ProfileDraft>, saved: DraftSource | null): void;
  delete(id: string): boolean;
};
export function createScenarioDrafts(): ScenarioDrafts;
