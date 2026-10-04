export type Visibility = 'shared' | 'private' | 'unknown';

export type PdfPage = {
  pageNumber: number;
  text: string;
  extractionStatus: 'success' | 'no_text' | 'error';
  extractionMessage: string;
  readable: boolean;
  hasImages: boolean | null;
  hasNonTextContent: boolean | null;
};

export type SourcePreview = {
  title: string;
  kind: Evidence['kind'];
  text: string;
  dataUrl: string;
  pageNumber: number | null;
  pageCount: number | null;
  pdfPages: PdfPage[];
  extractionMessage: string;
  error?: string;
};

export type Evidence = {
  id: string;
  title: string;
  originalName?: string;
  kind: 'text' | 'pdf' | 'image';
  extractedText?: string;
  attachmentPath?: string;
  extractionStatus?: string;
  extractionMessage?: string;
  // Optional for pre-page-metadata saved evidence.
  pdfMetadataVersion?: number;
  pdfPageCount?: number | null;
  pdfPages?: PdfPage[];
  byteSize?: number;
  visibility: Visibility;
  mimeType?: string;
  createdAt: string;
};

export type EventRecord = {
  timeText: string;
  people: string[];
  what: string;
  type: string;
  sourceId: string;
  page: string;
  quote: string;
  ambiguity: string;
  quoteOrigin?: string;
  quoteSource?: 'text' | 'image';
  // App-owned; never a model-provided verification claim.
  quoteVerification?: 'text_matched' | 'image_unverified' | 'legacy_text_matched';
};

export type Action = {
  id: string;
  title: string;
  who?: string;
  step: string;
  suggestedLine?: string;
  purpose?: string;
  secretRisk?: string;
  rationale: string;
  priority: number;
  evidenceIds: string[];
  // Optional for saved results from earlier versions. New analyses store an array.
  assumptions?: string[];
  grounding?: AnalysisGrounding;
  status: string;
  createdAt: string;
  updatedAt?: string;
  retiredAt?: string;
  retirementReason?: string;
  replacedByActionId?: string | null;
  restoredFromId?: string;
  restoredAt?: string;
}

export type AnalysisSource = Pick<Evidence, 'id' | 'title' | 'kind' | 'extractedText' | 'visibility'>;

export type Fact = { statement: string; evidenceIds: [string, ...string[]] };
export type Hypothesis = { statement: string; why: string; evidenceIds: string[]; assumptions?: string[] };

export type AnalysisGrounding = {
  // Older saved data lacks the complete input record and stays protected.
  version?: 1;
  includeRoleProfile: boolean;
  previousContextMayIncludeRoleProfile?: boolean;
  evidenceIds: string[];
  contextActionIds?: string[];
  contextHistoryActionIds?: string[];
};

export type Analysis = {
  revision: number;
  inputRevision: number;
  updatedAt: string;
  provider: string;
  overview: string;
  flow: { moment: string; summary: string; evidenceIds: string[] }[];
  events: EventRecord[];
  facts: Fact[];
  hypotheses: Hypothesis[];
  unknowns: { question: string; why: string; evidenceIds: string[] }[];
  actions: Action[];
  // App-owned snapshots of the fixed sources actually used in this analysis.
  sources?: AnalysisSource[];
  grounding?: AnalysisGrounding;
  usage?: { input_tokens?: number; output_tokens?: number } | null;
};

export type CodexModelOption = {
  id: string;
  displayName: string;
  inputModalities: string[];
  supportedEfforts: string[];
  defaultEffort: string | null;
  isDefault: boolean;
};

export type CodexConnectionStatus = {
  installed: boolean;
  executable?: string;
  authenticated: boolean;
  ready: boolean;
  authType: string | null;
  planType: string | null;
  reason?: string | null;
  models: CodexModelOption[];
  rateLimit: { usedPercent: number; windowDurationMins: number | null; resetsAt: number | null } | null;
  message: string;
};

export type Scenario = {
  id: string;
  title: string;
  synopsis: string;
  roleProfile: { role: string; goal: string; secret: string };
  evidence: Evidence[];
  analysis: Analysis | null;
  // Local snapshots excluded by the profile scope; never used as AI context.
  analysisHistory?: Analysis[];
  actionHistory: Action[];
  revision: number;
  createdAt: string;
  updatedAt: string;
};

export type AppSettings = {
  provider: 'none' | 'openai' | 'ollama' | 'codex';
  model: string;
  effort: string;
  ollamaUrl: string;
  ollamaModel: string;
  codexModel: string;
  codexEffort: string;
  codexCliPath: string;
  autoUpdate: boolean;
  includeRoleProfile: boolean;
  cloudConsent: boolean;
  codexConsent: boolean;
  hasKey: boolean;
  encryptionAvailable: boolean;
  dataFolder: string;
  fileLimitBytes: number;
  textLimitCharacters: number;
};

declare global {
  interface Window {
    makua: {
      getInfo: () => Promise<{ version: string; platform: string; dataFolder: string }>;
      showDataFolder: () => Promise<boolean>;
      getSettings: () => Promise<AppSettings>;
      saveSettings: (value: Record<string, unknown>) => Promise<AppSettings>;
      testAi: (value?: Record<string, unknown>) => Promise<{ ok: boolean; message: string; usage?: Analysis['usage']; codexStatus?: CodexConnectionStatus }>;
      startCodexLogin: (path?: string) => Promise<{ ok: boolean; message: string; verificationUrl?: string; userCode?: string }>;
      cancelCodexLogin: () => Promise<{ ok: boolean; message: string }>;
      chooseCodexCli: () => Promise<{ canceled?: boolean; path?: string }>;
      listScenarios: () => Promise<Scenario[]>;
      getScenario: (id: string) => Promise<Scenario>;
      createScenario: (title: string) => Promise<Scenario>;
      createDemo: () => Promise<Scenario>;
      saveProfile: (value: Record<string, unknown>) => Promise<Scenario>;
      deleteScenario: (id: string) => Promise<{ deleted: boolean }>;
      exportScenario: (id: string) => Promise<{ exported: boolean; path?: string }>;
      addText: (value: Record<string, unknown>) => Promise<Scenario>;
      addFiles: (id: string) => Promise<{ canceled?: boolean; scenario?: Scenario; addedCount?: number }>;
      addPastedImage: (value: Record<string, unknown>) => Promise<Scenario>;
      setVisibility: (value: Record<string, unknown>) => Promise<Scenario>;
      previewImage: (value: Record<string, unknown>) => Promise<string>;
      readSource: (value: { id: string; evidenceId: string; page?: string }) => Promise<SourcePreview>;
      completeAction: (value: Record<string, unknown>) => Promise<Scenario>;
      discardAction: (value: Record<string, unknown>) => Promise<Scenario>;
      restoreAction: (value: Record<string, unknown>) => Promise<Scenario>;
      analyze: (value: Record<string, unknown>) => Promise<{ status: string; message?: string; scenario?: Scenario; usage?: Analysis['usage']; textCharacters?: number; attachmentBytes?: number }>;
      cancelAnalysis: (value: Record<string, unknown>) => Promise<{ canceled: boolean }>;
    };
  }
}

export {};
