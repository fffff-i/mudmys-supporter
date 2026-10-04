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
  editedText?: string;
  snapshot?: boolean;
  snapshotUnavailable?: boolean;
  error?: string;
};

export type Evidence = {
  id: string;
  title: string;
  originalName?: string;
  kind: 'text' | 'pdf' | 'image';
  extractedText?: string;
  // The first saved body and attachment stay immutable; edits are a separate input.
  editedText?: string;
  originalTitle?: string;
  updatedAt?: string;
  analysisEnabled?: boolean;
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
  quoteSource?: 'text' | 'image' | 'edited';
  // App-owned; never a model-provided verification claim.
  quoteVerification?: 'text_matched' | 'image_unverified' | 'legacy_text_matched' | 'edited_text_matched';
};

export type ActionNotes = { reason: string; resultNote: string };
export type ActionRecheck = { actionId: string; previousPremise: string; currentPremise: string; reason: string };

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
  sourceSnapshots?: AnalysisSource[];
  rechecks?: ActionRecheck[];
  // App-owned provenance for later prose; the original action keeps its own grounding.
  retirementGrounding?: AnalysisGrounding;
  resultNote?: string;
  resultGrounding?: AnalysisGrounding;
  notesUpdatedAt?: string;
  status: string;
  createdAt: string;
  updatedAt?: string;
  retiredAt?: string;
  retirementReason?: string;
  replacedByActionId?: string | null;
  restoredFromId?: string;
  restoredAt?: string;
}

export type AnalysisSource = Pick<Evidence, 'id' | 'title' | 'kind' | 'extractedText' | 'visibility'> & Partial<Omit<Evidence, 'id' | 'title' | 'kind' | 'extractedText' | 'visibility'>>;

export type Fact = { statement: string; evidenceIds: [string, ...string[]] };
export type Hypothesis = { statement: string; why: string; evidenceIds: string[]; assumptions?: string[] };

export type AnalysisGrounding = {
  // Older saved data lacks the complete input record and stays protected.
  version?: 1;
  includeRoleProfile: boolean;
  previousContextMayIncludeRoleProfile?: boolean;
  evidenceIds: string[];
  evidenceOriginUnknown?: boolean;
  inputRevision?: number;
  contextActionIds?: string[];
  contextHistoryActionIds?: string[];
};

export type AnalysisResult = { status: string; message?: string; scenario?: Scenario; usage?: Analysis['usage']; textCharacters?: number; attachmentBytes?: number };

export type Analysis = {
  revision: number;
  inputRevision: number;
  settingsKey?: string;
  updatedAt: string;
  provider: string;
  overview: string;
  flow: { moment: string; summary: string; evidenceIds: string[] }[];
  events: EventRecord[];
  facts: Fact[];
  hypotheses: Hypothesis[];
  unknowns: { question: string; why: string; evidenceIds: string[] }[];
  actions: Action[];
  // App-owned snapshots of the source contents actually used in this analysis.
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
  settingsVersion?: number;
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
      chooseFiles: (id: string) => Promise<{ canceled?: boolean; files?: { token: string; name: string; kind: Evidence['kind']; byteSize: number; error?: string }[] }>;
      releaseFiles: (value: { id: string; tokens: string[] }) => Promise<void>;
      addEvidence: (value: Record<string, unknown>) => Promise<Scenario>;
      editEvidence: (value: Record<string, unknown>) => Promise<Scenario>;
      setEvidenceEnabled: (value: { id: string; evidenceId: string; enabled: boolean }) => Promise<Scenario>;
      addFiles: (id: string) => Promise<{ canceled?: boolean; scenario?: Scenario; addedCount?: number }>;
      addPastedImage: (value: Record<string, unknown>) => Promise<Scenario>;
      setVisibility: (value: Record<string, unknown>) => Promise<Scenario>;
      previewImage: (value: Record<string, unknown>) => Promise<string>;
      readSource: (value: { id: string; evidenceId: string; page?: string; analysisIndex?: number; actionId?: string; current?: boolean }) => Promise<SourcePreview>;
      completeAction: (value: Record<string, unknown>) => Promise<Scenario>;
      discardAction: (value: Record<string, unknown>) => Promise<Scenario>;
      updateActionNotes: (value: Record<string, unknown>) => Promise<Scenario>;
      restoreAction: (value: Record<string, unknown>) => Promise<Scenario>;
      analyze: (value: Record<string, unknown>) => Promise<AnalysisResult>;
      cancelAnalysis: (value: Record<string, unknown>) => Promise<{ canceled: boolean }>;
    };
  }
}

export {};
