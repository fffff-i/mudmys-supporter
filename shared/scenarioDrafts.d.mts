import type { Scenario, Visibility } from '../src/types';

export type DraftSource = Pick<Scenario, 'id' | 'revision' | 'title' | 'synopsis'> & Partial<Pick<Scenario, 'roleProfile'>>;
export type TextDraft = { title: string; text: string; visibility: Visibility };
export type ProfileDraft = { title: string; synopsis: string; role: string; goal: string; secret: string };
export type DraftSave<T> = { readonly id: string; readonly version: number; readonly value: Readonly<T> };
export type ScenarioDrafts = {
  read(scenario: DraftSource): { text: TextDraft; profile: ProfileDraft; textSaving: boolean; profileSaving: boolean };
  editText(scenario: DraftSource, patch: Partial<TextDraft>): void;
  editProfile(scenario: DraftSource, profile: ProfileDraft): void;
  beginTextSave(scenario: DraftSource): DraftSave<TextDraft> | null;
  finishTextSave(request: DraftSave<TextDraft>, saved: DraftSource | null): void;
  beginProfileSave(scenario: DraftSource): DraftSave<ProfileDraft> | null;
  finishProfileSave(request: DraftSave<ProfileDraft>, saved: DraftSource | null): void;
  delete(id: string): boolean;
};
export function createScenarioDrafts(): ScenarioDrafts;
