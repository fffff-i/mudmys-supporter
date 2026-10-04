import type { AppSettings, Scenario, AnalysisResult } from '../src/types';
import type { SelectionToken } from './selectionGuard.mjs';

export type AnalysisUpdateState = { id: string | null; phase: 'idle' | 'queued' | 'updating' | 'stopping'; pending: boolean; dirty: boolean };
export function analysisSettingsKey(settings: Partial<AppSettings>, includeAutomation?: boolean): string;
export function canAnalyze(settings: Partial<AppSettings>): boolean;
export function createAnalysisUpdater(options: {
  readScenario: (id: string) => Promise<Scenario>;
  readSettings?: () => Promise<AppSettings>;
  analyze: (request: Record<string, unknown>) => Promise<AnalysisResult>;
  cancel: (request: Record<string, unknown>) => Promise<unknown>;
  onScenario?: (scenario: Scenario, token: SelectionToken) => void;
  onResult?: (result: AnalysisResult, token: SelectionToken) => void;
  onState?: (state: AnalysisUpdateState) => void;
  delay?: number;
  newRunId?: () => string;
}): {
  observe(scenario: Scenario): boolean;
  changed(scenario: Scenario): void;
  setSettings(settings: AppSettings): void;
  select(token: SelectionToken): void;
  request(id: string): void;
  cancel(id: string): void;
  remove(id: string): void;
  dispose(): void;
  view(): AnalysisUpdateState;
};
