import type { SourcePreview } from '../src/types';

export type SourceRequest = { id: string; evidenceId: string; page?: string; analysisIndex?: number; actionId?: string; current?: boolean };
export type SourceViewState = {
  request: SourceRequest;
  verification?: string;
  loading: boolean;
  preview: SourcePreview | null;
  error: string;
};
export function createSourceReader(
  load: (request: SourceRequest) => Promise<SourcePreview>,
  update: (value: SourceViewState | null) => void
): { open: (request: SourceRequest, verification?: string) => Promise<void>; close: () => void };
