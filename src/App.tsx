import { FormEvent, ClipboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import { createSelectionGuard } from '../shared/selectionGuard.mjs';
import { createAnalysisUpdater, type AnalysisUpdateState } from '../shared/analysisUpdater.mjs';
import { createScenarioDrafts, type ProfileDraft, type TextDraft, type DraftCandidate, type EvidenceEdit } from '../shared/scenarioDrafts.mjs';
import { evidenceBody, evidenceUsage } from '../shared/evidence.mjs';
import { createSourceReader, type SourceViewState } from '../shared/sourceReader.mjs';
import type { Action, ActionNotes, AppSettings, CodexConnectionStatus, EventRecord, Evidence, Scenario, Visibility } from './types';

type Page = 'overview' | 'evidence' | 'plans' | 'history' | 'settings';
type OpenSource = (id: string, page?: string, verification?: string, analysisIndex?: number, scope?: { actionId?: string; current?: boolean }) => void;
const PAGES: { id: Page; label: string; mark: string }[] = [
  { id: 'overview', label: '現在地', mark: '○' },
  { id: 'evidence', label: '資料を追加', mark: '＋' },
  { id: 'plans', label: '次の一手', mark: '↗' },
  { id: 'history', label: '方針の履歴', mark: '↶' }
];
const DEFAULT_SETTINGS: AppSettings = {
  provider: 'none', model: 'gpt-6-luna', effort: 'medium', ollamaUrl: 'http://localhost:11434', ollamaModel: '',
  codexModel: '', codexEffort: '', codexCliPath: '', codexConsent: false,
  autoUpdate: false, includeRoleProfile: false, cloudConsent: false, hasKey: false, encryptionAvailable: false,
  dataFolder: '', fileLimitBytes: 40 * 1024 * 1024, textLimitCharacters: 300000
};

const scopeLabel: Record<Visibility, string> = { shared: '全体公開', private: '自分だけ', unknown: '公開状況不明' };
const scopeClass: Record<Visibility, string> = { shared: 'scope-shared', private: 'scope-private', unknown: 'scope-unknown' };

function dateLabel(value?: string) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat('ja-JP', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date);
}

function bytesLabel(value: number) {
  if (value >= 1024 * 1024) return (value / (1024 * 1024)).toFixed(1) + ' MiB';
  if (value >= 1024) return Math.round(value / 1024) + ' KiB';
  return value + ' B';
}

function typeLabel(type: string) {
  return ({ observed: '直接観察', reported: '伝聞', statement: '発言', recorded: '記録', inference: '推測', unknown: '不明' } as Record<string, string>)[type] || '不明';
}

function savedAnalysisSources(scenario: Scenario) {
  const sources = [...(scenario.analysis?.sources || []), ...(scenario.analysisHistory || []).slice().reverse().flatMap((analysis) => analysis.sources || [])];
  return sources.filter((source, index) => sources.findIndex((item) => item.id === source.id && item.title === source.title && item.extractedText === source.extractedText && item.editedText === source.editedText) === index);
}

function sourceHistoryIndex(scenario: Scenario, id: string) {
  const source = savedAnalysisSources(scenario).find((item) => item.id === id);
  if (!source) return undefined;
  const index = (scenario.analysisHistory || []).findIndex((analysis) => analysis.sources?.includes(source));
  return index < 0 ? undefined : index;
}

function actionSource(scenario: Scenario, action: Action, id: string) {
  const own = action.sourceSnapshots?.find((source) => source.id === id);
  if (own || !Number.isSafeInteger(action.grounding?.inputRevision)) return own;
  return [scenario.analysis, ...(scenario.analysisHistory || [])].find((analysis) => analysis?.inputRevision === action.grounding?.inputRevision)?.sources?.find((source) => source.id === id);
}

function sourceName(scenario: Scenario, id: string, analysisIndex?: number, scope?: { actionId?: string; current?: boolean }) {
  const action = scope?.actionId ? [...(scenario.analysis?.actions || []), ...(scenario.actionHistory || [])].find((item) => item.id === scope.actionId) : undefined;
  const source = scope?.current ? null : action ? actionSource(scenario, action, id) :
    (analysisIndex === undefined ? savedAnalysisSources(scenario).find((item) => item.id === id) : scenario.analysisHistory?.[analysisIndex]?.sources?.find((item) => item.id === id));
  if (source) return source.title;
  const index = scenario.evidence.findIndex((entry) => entry.id === id);
  return index >= 0 ? '資料 ' + String(index + 1).padStart(2, '0') + '　' + (scope?.current ? scenario.evidence[index].title : scenario.evidence[index].originalTitle || scenario.evidence[index].title) : '資料がありません';
}

function App() {
  const selectionGuard = useRef(createSelectionGuard());
  const scenarioDrafts = useRef(createScenarioDrafts());
  const displayedScenario = useRef<Scenario | null>(null);
  const deletedScenarioIds = useRef(new Set<string>());
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [scenario, setScenario] = useState<Scenario | null>(null);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [codexStatus, setCodexStatus] = useState<CodexConnectionStatus | null>(null);
  const [page, setPage] = useState<Page>('overview');
  const [loading, setLoading] = useState(true);
  const [analysisState, setAnalysisState] = useState<AnalysisUpdateState>({ id: null, phase: 'idle', pending: false, dirty: false });
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [selectedEvidence, setSelectedEvidence] = useState('');
  const [preview, setPreview] = useState('');
  const [sourceView, setSourceView] = useState<SourceViewState | null>(null);
  const sourceReader = useRef(createSourceReader((request) => window.makua.readSource(request), setSourceView));
  const actionWrites = useRef(new Set<string>());
  const [pendingActionKeys, setPendingActionKeys] = useState<string[]>([]);
  const [noteDrafts, setNoteDrafts] = useState<Record<string, ActionNotes>>({});
  const pendingActionIds = scenario ? pendingActionKeys.filter((key) => key.startsWith(scenario.id + '/')).map((key) => key.slice(scenario.id.length + 1)) : [];
  const [, setDraftVersion] = useState(0);
  const draft = scenario && !deletedScenarioIds.current.has(scenario.id) ? scenarioDrafts.current.read(scenario) : null;
  const refreshDrafts = () => setDraftVersion((current) => current + 1);
  const analysisUpdater = useRef<ReturnType<typeof createAnalysisUpdater> | null>(null);
  if (!analysisUpdater.current) analysisUpdater.current = createAnalysisUpdater({
    readScenario: (id) => window.makua.getScenario(id),
    readSettings: () => window.makua.getSettings(),
    analyze: (request) => window.makua.analyze(request),
    cancel: (request) => window.makua.cancelAnalysis(request),
    onState: setAnalysisState,
    onScenario: (next, token) => { mergeScenario(next); applyScenario(next, token); },
    onResult: (result, token) => {
      if (!selectionGuard.current.isCurrent(token)) return;
      if (result.status === 'ok') {
        const usage = result.usage;
        const usageLabel = usage?.input_tokens != null ? ' 入力 ' + usage.input_tokens.toLocaleString() + ' / 出力 ' + (usage.output_tokens || 0).toLocaleString() + ' tokens。' : '';
        setError('');
        setNotice('解析を更新しました。' + usageLabel);
      } else if (result.status === 'error') {
        setError((result.message || '解析に失敗しました。') + ' 資料と前回の結果は保持されています。');
        setNotice('');
      } else {
        setNotice(result.status === 'stale' ? '資料は保存済みです。未反映の情報があります。' : result.message || '資料は保存済みです。');
      }
    }
  });
  const busy = analysisState.id === scenario?.id && analysisState.phase !== 'idle';
  const receiveSettings = (next: AppSettings) => {
    analysisUpdater.current!.setSettings(next);
    setSettings(next);
  };


  const activeActions = scenario?.analysis?.actions.filter((action) => action.status === 'active') || [];
  const historyActions = scenario?.actionHistory || [];
  const usage = useMemo(() => scenario ? evidenceUsage(scenario, settings.includeRoleProfile) : { textCharacters: 0, attachmentBytes: 0, retainedBytes: 0, count: 0 }, [scenario, settings.includeRoleProfile]);
  const aiConnected = settings.provider === 'openai'
    ? settings.hasKey && settings.cloudConsent
    : settings.provider === 'ollama'
      ? Boolean(settings.ollamaModel)
      : settings.provider === 'codex' && settings.codexConsent && Boolean(codexStatus?.ready);

  useEffect(() => {
    if (settings.provider !== 'codex' || !settings.codexConsent) setCodexStatus(null);
  }, [settings.provider, settings.codexConsent]);

  const applyScenario = (next: Scenario, token: ReturnType<ReturnType<typeof createSelectionGuard>['capture']>) => {
    if (deletedScenarioIds.current.has(next.id) || !selectionGuard.current.canApply(token, next, displayedScenario.current)) return false;
    if (displayedScenario.current?.id !== next.id) sourceReader.current.close();
    displayedScenario.current = next;
    setScenario(next);
    analysisUpdater.current!.observe(next);
    return true;
  };

  const mergeScenario = (next: Scenario) => {
    if (deletedScenarioIds.current.has(next.id)) return;
    setScenarios((current) => {
      const existing = current.find((item) => item.id === next.id);
      const merged = existing && existing.revision > next.revision ? existing : next;
      return [merged, ...current.filter((item) => item.id !== next.id)].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    });
  };

  useEffect(() => {
    let mounted = true;
    Promise.all([window.makua.listScenarios(), window.makua.getSettings()]).then(async ([list, preferences]) => {
      if (!mounted) return;
      setScenarios(list);
      receiveSettings(preferences);
      const token = selectionGuard.current.select(list[0]?.id || null);
      analysisUpdater.current!.select(token);
      if (list.length) {
        const loaded = await window.makua.getScenario(list[0].id);
        if (mounted && selectionGuard.current.isCurrent(token)) applyScenario(loaded, token);
      }
      setLoading(false);
    }).catch((reason) => {
      if (mounted) { setError(String(reason?.message || reason)); setLoading(false); }
    });
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    if (!selectedEvidence) { setPreview(''); return; }
    setPreview('');
  }, [selectedEvidence, scenario?.id]);

  useEffect(() => {
    if (!sourceView) return;
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') sourceReader.current.close(); };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [Boolean(sourceView)]);

  useEffect(() => () => { sourceReader.current.close(); analysisUpdater.current!.dispose(); }, []);

  const reportError = (reason: unknown, token?: ReturnType<ReturnType<typeof createSelectionGuard>['capture']>) => {
    if (token && !selectionGuard.current.isCurrent(token)) return;
    const message = String((reason as Error)?.message || reason || '処理に失敗しました。');
    setError(message);
    setNotice('');
  };

  const updateScenario = async (next: Scenario, message: string, inputChanged = true, token = selectionGuard.current.capture()) => {
    if (deletedScenarioIds.current.has(next.id)) return;
    if (inputChanged) analysisUpdater.current!.changed(next); else analysisUpdater.current!.observe(next);
    mergeScenario(next);
    if (!selectionGuard.current.isCurrent(token) || token.id !== next.id) return;
    if (!applyScenario(next, token)) return;
    setError('');
    setNotice(message);
  };

  const updateDraftScenario = async (saved: Scenario, message: string, token: ReturnType<ReturnType<typeof createSelectionGuard>['capture']>) => {
    if (deletedScenarioIds.current.has(saved.id)) return;
    if (selectionGuard.current.isCurrent(token)) {
      await updateScenario(saved, message, true, token);
      return;
    }
    analysisUpdater.current!.changed(saved);
    mergeScenario(saved);
    const currentToken = selectionGuard.current.capture();
    if (currentToken.id !== saved.id) return;
    // Returning during a save starts a new selection. Read its current record
    // rather than applying the response belonging to the earlier selection.
    try {
      const loaded = await window.makua.getScenario(saved.id);
      await updateScenario(loaded, message, false, currentToken);
    } catch (reason) { reportError(reason, currentToken); }
  };

  const editTextDraft = (patch: Partial<TextDraft>) => {
    if (!scenario || selectionGuard.current.capture().id !== scenario.id) return;
    scenarioDrafts.current.editText(scenario, patch);
    refreshDrafts();
  };

  const editProfileDraft = (profile: ProfileDraft) => {
    if (!scenario || selectionGuard.current.capture().id !== scenario.id) return;
    scenarioDrafts.current.editProfile(scenario, profile);
    refreshDrafts();
  };

  const runAnalysis = () => {
    const target = displayedScenario.current;
    if (target && selectionGuard.current.capture().id === target.id) analysisUpdater.current!.request(target.id);
  };

  const openScenario = async (id: string) => {
    sourceReader.current.close();
    const token = selectionGuard.current.select(id);
    analysisUpdater.current!.select(token);
    const cached = scenarios.find((item) => item.id === id);
    if (cached) applyScenario(cached, token);
    else { displayedScenario.current = null; setScenario(null); }
    setPage('overview');
    setSelectedEvidence('');
    setNotice('');
    setError('');
    try {
      const loaded = await window.makua.getScenario(id);
      if (!selectionGuard.current.isCurrent(token)) return;
      mergeScenario(loaded);
      applyScenario(loaded, token);
    } catch (reason) { reportError(reason, token); }
  };

  const cancelCurrentAnalysis = () => {
    const id = selectionGuard.current.capture().id;
    if (id) analysisUpdater.current!.cancel(id);
    setNotice('更新を中止しました。資料と前回結果は保持しています。');
  };

  const receiveCodexStatus = (status: CodexConnectionStatus | null) => setCodexStatus(status);

  const createScenario = async (event: FormEvent) => {
    event.preventDefault();
    const requestedFrom = selectionGuard.current.capture();
    try {
      const created = await window.makua.createScenario(newTitle);
      mergeScenario(created);
      if (!selectionGuard.current.isCurrent(requestedFrom)) return;
      setNewTitle('');
      setCreateOpen(false);
      const token = selectionGuard.current.select(created.id);
      analysisUpdater.current!.select(token);
      applyScenario(created, token);
      setPage('overview');
      setNotice('シナリオを作成しました。概要と役の目的を記録できます。');
    } catch (reason) { reportError(reason, requestedFrom); }
  };

  const createDemo = async () => {
    const requestedFrom = selectionGuard.current.capture();
    try {
      const created = await window.makua.createDemo();
      mergeScenario(created);
      if (!selectionGuard.current.isCurrent(requestedFrom)) return;
      const token = selectionGuard.current.select(created.id);
      analysisUpdater.current!.select(token);
      applyScenario(created, token);
      setPage('overview');
      setNotice('架空のデモ資料を追加しました。AI解析ではなく画面例です。');
    } catch (reason) { reportError(reason, requestedFrom); }
  };

  const saveProfile = async (event: FormEvent) => {
    event.preventDefault();
    if (!scenario || selectionGuard.current.capture().id !== scenario.id) return;
    const token = selectionGuard.current.capture();
    const request = scenarioDrafts.current.beginProfileSave(scenario);
    if (!request) return;
    refreshDrafts();
    try {
      const saved = await window.makua.saveProfile({ id: request.id, expectedRevision: scenario.revision,
        expectedProfile: { title: scenario.title, synopsis: scenario.synopsis, role: scenario.roleProfile?.role || '', goal: scenario.roleProfile?.goal || '', secret: scenario.roleProfile?.secret || '' }, ...request.value });
      scenarioDrafts.current.finishProfileSave(request, saved);
      refreshDrafts();
      await updateDraftScenario(saved, 'シナリオ情報を保存しました。', token);
    } catch (reason) {
      scenarioDrafts.current.finishProfileSave(request, null);
      refreshDrafts();
      reportError(reason, token);
    }
  };

  const addText = async (event: FormEvent) => {
    event.preventDefault();
    if (!scenario || selectionGuard.current.capture().id !== scenario.id) return;
    const token = selectionGuard.current.capture();
    const request = scenarioDrafts.current.beginTextSave(scenario);
    if (!request) return;
    refreshDrafts();
    try {
      const saved = await window.makua.addEvidence({ id: request.id, ...request.value,
        fileTokens: request.candidates.filter((item) => item.type === 'file').map((item) => item.token),
        images: request.candidates.filter((item) => item.type === 'image').map((item) => ({ dataUrl: item.dataUrl })) });
      scenarioDrafts.current.finishTextSave(request, saved);
      refreshDrafts();
      await updateDraftScenario(saved, '追加した資料をまとめて保存しました。', token);
    } catch (reason) {
      scenarioDrafts.current.finishTextSave(request, null);
      refreshDrafts();
      reportError(reason, token);
    }
  };

  const addFiles = async () => {
    if (!scenario || selectionGuard.current.capture().id !== scenario.id) return;
    const target = scenario;
    const token = selectionGuard.current.capture();
    try {
      const result = await window.makua.chooseFiles(target.id);
      if (result.canceled || !result.files) return;
      if (deletedScenarioIds.current.has(target.id)) { await window.makua.releaseFiles({ id: target.id, tokens: result.files.map((file) => file.token) }); return; }
      scenarioDrafts.current.appendCandidates(target, result.files.map((file) => ({ ...file, id: file.token, type: 'file' })));
      refreshDrafts();
    } catch (reason) { reportError(reason, token); }
  };

  const handlePasteImage = async (event: ClipboardEvent<HTMLFormElement>) => {
    if (!scenario || selectionGuard.current.capture().id !== scenario.id) return;
    const files = Array.from(event.clipboardData.items).filter((item) => /^image\/(png|jpeg|webp)$/.test(item.type))
      .map((item) => item.getAsFile()).filter((file): file is File => Boolean(file));
    if (!files.length) return;
    event.preventDefault();
    const target = scenario;
    const token = selectionGuard.current.capture();
    const pastedText = event.clipboardData.getData('text/plain');
    if (pastedText) editTextDraft({ text: (scenarioDrafts.current.read(target).text.text || '') + pastedText });
    const candidates = files.map((file) => ({ id: crypto.randomUUID(), type: 'image' as const, name: '貼り付け画像', byteSize: file.size, loading: true }));
    scenarioDrafts.current.appendCandidates(target, candidates);
    refreshDrafts();
    await Promise.all(files.map(async (file, index) => {
      try {
        if (file.size > 20 * 1024 * 1024) throw new Error('画像は20MiB以下にしてください。');
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(new Error('クリップボード画像を読み取れませんでした。'));
          reader.readAsDataURL(file);
        });
        if (!deletedScenarioIds.current.has(target.id)) scenarioDrafts.current.updateCandidate(target, candidates[index].id, { dataUrl, loading: false });
      } catch (reason) {
        if (!deletedScenarioIds.current.has(target.id)) scenarioDrafts.current.updateCandidate(target, candidates[index].id, { loading: false, error: String((reason as Error).message) });
        reportError(reason, token);
      }
      refreshDrafts();
    }));
  };

  const removeCandidate = (candidate: DraftCandidate) => {
    if (!scenario || !scenarioDrafts.current.removeCandidate(scenario, candidate.id)) return;
    if (candidate.token) window.makua.releaseFiles({ id: scenario.id, tokens: [candidate.token] }).catch(reportError);
    refreshDrafts();
  };

  const editEvidenceDraft = (item: Evidence, patch: Partial<EvidenceEdit>) => {
    if (!scenario || selectionGuard.current.capture().id !== scenario.id) return;
    scenarioDrafts.current.editEvidence(scenario, item, patch);
    refreshDrafts();
  };

  const saveEvidence = async (item: Evidence, event: FormEvent) => {
    event.preventDefault();
    if (!scenario || selectionGuard.current.capture().id !== scenario.id) return;
    const token = selectionGuard.current.capture();
    const request = scenarioDrafts.current.beginEvidenceSave(scenario, item);
    if (!request) return;
    refreshDrafts();
    try {
      const saved = await window.makua.editEvidence({ id: request.id, evidenceId: item.id, ...request.value });
      scenarioDrafts.current.finishEvidenceSave(request, saved);
      refreshDrafts();
      await updateDraftScenario(saved, '資料を編集しました。原本と以前の出典は保持しています。', token);
    } catch (reason) {
      scenarioDrafts.current.finishEvidenceSave(request, null); refreshDrafts(); reportError(reason, token);
    }
  };

  const setEvidenceEnabled = async (item: Evidence) => {
    if (!scenario || selectionGuard.current.capture().id !== scenario.id) return;
    const token = selectionGuard.current.capture();
    try {
      const enabled = item.analysisEnabled === false;
      const saved = await window.makua.setEvidenceEnabled({ id: scenario.id, evidenceId: item.id, enabled });
      await updateDraftScenario(saved, enabled ? '資料を解析対象に戻しました。' : '資料を解析対象から外しました。原本は保持しています。', token);
    } catch (reason) { reportError(reason, token); }
  };

  const setEvidenceVisibility = async (item: Evidence, visibility: Visibility) => {
    if (!scenario) return;
    const token = selectionGuard.current.capture();
    try {
      const saved = await window.makua.setVisibility({ id: scenario.id, evidenceId: item.id, visibility });
      await updateScenario(saved, '公開範囲を更新しました。', true, token);
    } catch (reason) { reportError(reason, token); }
  };

  const changeAction = async (action: Action, save: () => Promise<Scenario>, message: string) => {
    const token = selectionGuard.current.capture();
    if (!scenario || token.id !== scenario.id || deletedScenarioIds.current.has(scenario.id)) return null;
    const key = scenario.id + '/' + action.id;
    if (actionWrites.current.has(key)) return null;
    actionWrites.current.add(key);
    setPendingActionKeys([...actionWrites.current]);
    try {
      const saved = await save();
      if (selectionGuard.current.isCurrent(token)) await updateScenario(saved, message, true, token);
      else {
        analysisUpdater.current!.changed(saved);
        mergeScenario(saved);
        const currentToken = selectionGuard.current.capture();
        if (currentToken.id === saved.id) {
          const fresh = await window.makua.getScenario(saved.id);
          await updateScenario(fresh, message, false, currentToken);
        }
      }
      return saved;
    } catch (reason) { reportError(reason, token); return null; }
    finally { actionWrites.current.delete(key); setPendingActionKeys([...actionWrites.current]); }
  };

  const completeAction = async (action: Action) => {
    if (!scenario) return;
    const id = scenario.id;
    await changeAction(action, () => window.makua.completeAction({ id, actionId: action.id }), '完了を記録しました。得た回答は履歴へ任意で追加できます。');
  };

  const discardAction = async (action: Action) => {
    if (!scenario) return;
    const id = scenario.id;
    await changeAction(action, () => window.makua.discardAction({ id, actionId: action.id }), '見送りを記録しました。理由は履歴へ任意で追加できます。');
  };

  const restoreAction = async (action: Action) => {
    if (!scenario) return;
    const id = scenario.id;
    await changeAction(action, () => window.makua.restoreAction({ id, actionId: action.id }), '履歴から明示的に現在の方針へ戻しました。');
  };

  const notesFor = (action: Action): ActionNotes => noteDrafts[scenario?.id + '/' + action.id] || { reason: action.retirementReason || '', resultNote: action.resultNote || '' };
  const editActionNotes = (action: Action, notes: ActionNotes) => {
    if (!scenario || selectionGuard.current.capture().id !== scenario.id) return;
    const key = scenario.id + '/' + action.id;
    setNoteDrafts((current) => ({ ...current, [key]: notes }));
  };
  const saveActionNotes = async (action: Action, notes: ActionNotes) => {
    if (!scenario) return;
    const id = scenario.id;
    const key = id + '/' + action.id;
    const snapshot = { ...notes };
    const saved = await changeAction(action, () => window.makua.updateActionNotes({ id, actionId: action.id, ...snapshot }), '任意の履歴メモを保存しました。');
    if (saved) setNoteDrafts((current) => {
      if (current[key]?.reason !== snapshot.reason || current[key]?.resultNote !== snapshot.resultNote) return current;
      const remaining = { ...current }; delete remaining[key]; return remaining;
    });
  };

  const deleteScenario = async () => {
    if (!scenario) return;
    const targetId = scenario.id;
    const token = selectionGuard.current.capture();
    try {
      const answer = await window.makua.deleteScenario(targetId);
      if (!answer.deleted) return;
      deletedScenarioIds.current.add(targetId);
      analysisUpdater.current!.remove(targetId);
      scenarioDrafts.current.delete(targetId);
      const remaining = (await window.makua.listScenarios());
      setScenarios((current) => remaining.map((fresh) => {
        const existing = current.find((item) => item.id === fresh.id);
        return existing && existing.revision > fresh.revision ? existing : fresh;
      }).filter((item) => !deletedScenarioIds.current.has(item.id)));
      if (!selectionGuard.current.isCurrent(token)) return;
      const nextId = remaining.find((item) => !deletedScenarioIds.current.has(item.id))?.id || null;
      const nextToken = selectionGuard.current.select(nextId);
      analysisUpdater.current!.select(nextToken);
      if (nextId) {
        const loaded = await window.makua.getScenario(nextId);
        if (!selectionGuard.current.isCurrent(nextToken)) return;
        applyScenario(loaded, nextToken);
      } else {
        displayedScenario.current = null;
        setScenario(null);
      }
      setPage('overview');
      setNotice('対象シナリオと添付資料を削除しました。');
    } catch (reason) { reportError(reason, token); }
  };

  const exportScenario = async () => {
    if (!scenario) return;
    const token = selectionGuard.current.capture();
    try {
      const result = await window.makua.exportScenario(scenario.id);
      if (selectionGuard.current.isCurrent(token) && result.exported) setNotice('バックアップを作成しました: ' + result.path);
    } catch (reason) { reportError(reason, token); }
  };

  const previewImage = async (item: Evidence) => {
    if (!scenario || !item.attachmentPath) return;
    const token = selectionGuard.current.capture();
    try {
      const image = await window.makua.previewImage({ id: scenario.id, evidenceId: item.id });
      if (selectionGuard.current.isCurrent(token) && scenario?.id === token.id && selectedEvidence === item.id) setPreview(image);
    } catch (reason) { reportError(reason, token); }
  };

  const goToEvidence: OpenSource = (id, sourcePage, verification, analysisIndex, scope) => {
    if (!scenario) return;
    void sourceReader.current.open({ id: scenario.id, evidenceId: id, page: sourcePage, analysisIndex, ...scope }, verification);
  };

  if (loading) return <div className="loading-screen"><div className="brand-stamp">幕</div><p>資料の棚を開いています…</p></div>;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-row">
          <div className="brand-stamp">幕</div>
          <div><div className="brand-name">幕間ノート</div><div className="brand-subtitle">MYSTERY DESK</div></div>
        </div>
        <div className="sidebar-section-label">SESSION BOOK</div>
        <div className="side-nav">
          {PAGES.map((item) => <button key={item.id} className={'side-nav-item ' + (page === item.id ? 'selected' : '')} onClick={() => setPage(item.id)}>
            <span className="side-mark">{item.mark}</span><span>{item.label}</span>{item.id === 'plans' && activeActions.length > 0 && <span className="nav-count">{activeActions.length}</span>}
          </button>)}
        </div>
        <div className="scenario-head"><span>シナリオ</span><button aria-label="新しいシナリオ" title="新しいシナリオ" onClick={() => setCreateOpen((value) => !value)}>＋</button></div>
        {createOpen && <form className="quick-create" onSubmit={createScenario}><input autoFocus value={newTitle} onChange={(event) => setNewTitle(event.target.value)} placeholder="シナリオ名"/><button type="submit">作成</button></form>}
        <div className="scenario-list">
          {scenarios.map((item) => <button key={item.id} className={'scenario-switch ' + (scenario?.id === item.id ? 'active' : '')} onClick={() => openScenario(item.id)}>
            <span className="scenario-dot"/><span className="scenario-title-wrap"><span className="scenario-title">{item.title}</span><span className="scenario-meta">{item.evidence.length} 件の資料 ・ {dateLabel(item.updatedAt)}</span></span>
          </button>)}
          {!scenarios.length && <div className="sidebar-empty">まだシナリオはありません。<br/>架空デモで画面を試せます。</div>}
        </div>
        <div className="sidebar-bottom">
          {!scenarios.some((item) => item.title.includes('架空デモ')) && <button className="demo-link" onClick={createDemo}><span>✦</span> 架空デモを開く</button>}
          <div className="local-status"><span className="status-light"/><span>このPCに保存</span><span className="status-divider">·</span><span>{aiConnected ? settings.provider === 'openai' ? 'OpenAI 接続' : settings.provider === 'codex' ? 'Codex 接続' : 'ローカルAI' : 'AI未接続'}</span></div>
          <button className="settings-link" onClick={() => setPage('settings')}><span>⚙</span> 接続と保存の設定</button>
        </div>
      </aside>

      <div className="workspace">
        <header className="topbar">
          <div><div className="eyebrow">{scenario ? 'CASE NOTE / ' + (scenario.analysis?.provider?.startsWith('架空デモ') ? 'SAMPLE' : 'PLAY SESSION') : 'PRIVATE WORKSPACE'}</div><div className="topbar-title">{page === 'settings' ? '接続と保存の設定' : scenario?.title || '推理の余白を、ひとつずつ。'}</div></div>
          <div className="topbar-actions">
            <div className={'connection-pill ' + (aiConnected ? 'connected' : '')}><span className="status-light"/>{aiConnected ? settings.provider === 'openai' ? 'OpenAI API' : settings.provider === 'codex' ? 'Codex Plus枠' : 'Ollama ローカル' : 'AI未接続'}</div>
            {scenario && page !== 'settings' && busy
              ? <button className="button button-light" onClick={cancelCurrentAnalysis}>解析を中止</button>
              : scenario && page !== 'settings' && <button className="button button-ink" onClick={() => runAnalysis()} disabled={busy}><span className="sparkle">✳</span>{busy ? '更新中…' : '状況を更新'}</button>}
          </div>
        </header>

        <main className={'main-content' + (page === 'settings' ? ' main-content-settings' : '')}>
          {scenario && page !== 'settings' && analysisState.id === scenario.id && <AnalysisStatus state={analysisState}/>}
          {(notice || error) && <div className={'toast ' + (error ? 'toast-error' : '')}><span>{error ? '!' : '✓'}</span><div>{error || notice}</div><button onClick={() => { setNotice(''); setError(''); }} aria-label="閉じる">×</button></div>}
          {!scenario && page !== 'settings' && <EmptyState onNew={() => setCreateOpen(true)} onDemo={createDemo} />}
          {scenario && page === 'overview' && <Overview scenario={scenario} settings={settings} busy={busy} activeActions={activeActions} onEdit={() => setPage('evidence')} onPlans={() => setPage('plans')} onEvidence={goToEvidence} onComplete={completeAction} onDiscard={discardAction} pendingActionIds={pendingActionIds} />}
          {scenario && draft && page === 'evidence' && <EvidencePage scenario={scenario} title={draft.text.title} setTitle={(title) => editTextDraft({ title })} draft={draft.text.text} setDraft={(text) => editTextDraft({ text })} visibility={draft.text.visibility} setVisibility={(visibility) => editTextDraft({ visibility })} textSaving={draft.textSaving} profileSaving={draft.profileSaving} onAddText={addText} onAddFiles={addFiles} candidates={draft.candidates} onRemoveCandidate={removeCandidate} onPaste={handlePasteImage} editFor={(item) => scenarioDrafts.current.readEvidence(scenario, item)} onEvidenceEdit={editEvidenceDraft} onEvidenceSave={saveEvidence} onEvidenceEnabled={setEvidenceEnabled} onVisibility={setEvidenceVisibility} selected={selectedEvidence} onSelect={setSelectedEvidence} preview={preview} onPreview={previewImage} onSource={goToEvidence} onProfileSave={saveProfile} profile={draft.profile} setProfile={editProfileDraft} totalChars={usage.textCharacters} totalBytes={usage.attachmentBytes} retainedBytes={usage.retainedBytes} settings={settings} />}
          {scenario && page === 'plans' && <PlansPage scenario={scenario} actions={activeActions} settings={settings} busy={busy} onAnalyze={() => runAnalysis()} onEvidence={goToEvidence} onComplete={completeAction} onDiscard={discardAction} pendingActionIds={pendingActionIds} />}
          {scenario && page === 'history' && <HistoryPage scenario={scenario} history={historyActions} onRestore={restoreAction} onEvidence={goToEvidence} notesFor={notesFor} onNotesChange={editActionNotes} onNotesSave={saveActionNotes} pendingActionIds={pendingActionIds} />}
          {page === 'settings' && <div className="settings-scroll" role="region" aria-label="接続と保存の設定" tabIndex={0}><SettingsPage settings={settings} onSettings={receiveSettings} onSaved={receiveSettings} onCodexStatus={receiveCodexStatus} codexStatus={codexStatus} onDataFolder={() => window.makua.showDataFolder()} onError={reportError} onDelete={deleteScenario} scenario={scenario} /></div>}
          {scenario && sourceView && <SourcePanel view={sourceView} title={sourceName(scenario, sourceView.request.evidenceId, sourceView.request.analysisIndex, { actionId: sourceView.request.actionId, current: sourceView.request.current })} onClose={() => sourceReader.current.close()} onPage={(number) => goToEvidence(sourceView.request.evidenceId, String(number), sourceView.verification, sourceView.request.analysisIndex, { current: sourceView.request.current, actionId: sourceView.request.actionId })}/>}
        </main>
        {scenario && page !== 'settings' && <footer className="session-footer"><span>自動保存</span><span className="footer-dot">·</span><span>{scenario.evidence.length} 件の資料</span><span className="footer-dot">·</span><span>更新 {dateLabel(scenario.updatedAt)}</span>{settings.autoUpdate && <span className="footer-auto">自動更新 ON</span>}<button onClick={exportScenario}>バックアップを書き出す</button><button className="footer-delete" onClick={deleteScenario}>シナリオを削除</button></footer>}
      </div>
    </div>
  );
}

function quoteVerificationLabel(value?: string) {
  return value === 'edited_text_matched' ? '編集本文と一致・原本未照合' : value === 'text_matched' ? 'テキスト照合済み' : value === 'image_unverified' ? '画像読取・引用未照合' : '旧形式・ページ未照合';
}

function SourcePanel({ view, title, onClose, onPage }: { view: SourceViewState; title: string; onClose: () => void; onPage: (page: number) => void }) {
  const preview = view.preview;
  const page = preview?.pdfPages.find((entry) => entry.pageNumber === preview.pageNumber);
  return <section className="source-panel" role="region" aria-label="原本を確認">
    <div className="source-panel-head"><div><span className="panel-kicker">原本を確認</span><h2>{preview?.title || title}</h2></div><button className="button button-light" onClick={onClose} aria-label="原本を閉じる">閉じる ×</button></div>
    {view.verification && <p className="source-verification">引用：{quoteVerificationLabel(view.verification)}</p>}
    {view.loading && <p role="status" className="muted-copy">原本を読み込み中…</p>}
    {preview?.kind === 'pdf' && <div className="source-page-controls">
      <button className="button button-light" disabled={view.loading || !preview.pageNumber || preview.pageNumber <= 1} onClick={() => onPage((preview.pageNumber || 1) - 1)}>前へ</button>
      <label>p. <input key={preview.pageNumber} aria-label="原本のページ番号" type="number" min={1} max={preview.pageCount || undefined} defaultValue={preview.pageNumber || 1} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); onPage(Number(event.currentTarget.value)); } }}/></label>
      <span>/ {preview.pageCount ?? '不明'}</span>
      <button className="button button-light" disabled={view.loading || !preview.pageCount || !preview.pageNumber || preview.pageNumber >= preview.pageCount} onClick={() => onPage((preview.pageNumber || 1) + 1)}>次へ</button>
    </div>}
    {view.error && <p role="alert" className="source-error">{view.error}</p>}
    {preview?.snapshot && <p className="source-snapshot-note">解析に使った保存当時の内容です。</p>}
    {preview?.snapshotUnavailable && <p className="source-snapshot-note">保存当時の編集本文は記録されていないため、初回の原文を表示しています。</p>}
    {preview?.editedText !== undefined && <details className="source-text" open><summary>解析に使う編集本文（原本未照合）</summary><pre className="raw-source">{preview.editedText || '本文なし'}</pre></details>}
    {page && <p className={'source-page-state' + (page.extractionStatus === 'error' ? ' source-error' : '')}>このページ：{page.extractionStatus === 'success' ? '本文抽出あり' : page.extractionStatus === 'no_text' ? '本文抽出なし' : '本文抽出エラー'}{page.hasImages ? '・画像あり' : ''}{page.extractionMessage ? ' — ' + page.extractionMessage : ''}</p>}
    {preview?.kind === 'pdf' && preview.extractionMessage && <p className="muted-copy">{preview.extractionMessage}</p>}
    {preview?.dataUrl && <div className="source-original"><img src={preview.dataUrl} alt={preview.title + (preview.pageNumber ? ' 原本 p.' + preview.pageNumber : ' 原本')}/></div>}
    {preview?.text && <details className="source-text" open={preview.kind === 'text' || Boolean(view.error)}><summary>{preview.kind === 'pdf' && !view.error ? 'このページの抽出本文' : '保存された原文'}</summary><pre className="raw-source">{preview.text}</pre></details>}
    {!view.loading && preview && !view.error && !preview.dataUrl && !preview.text && <p className="muted-copy">表示できる本文はありません。</p>}
  </section>;
}

function AnalysisStatus({ state }: { state: AnalysisUpdateState }) {
  if (state.phase === 'idle' && !state.dirty) return null;
  const text = state.phase === 'stopping' ? '更新を停止しています。資料は保存済みです。'
    : state.phase === 'updating' ? state.pending ? '更新中・追加情報は保存済み。次の更新に反映します。' : '保存済みの情報から更新中…'
    : state.phase === 'queued' ? '保存済みの情報をまとめて更新します…' : '保存済み・未反映';
  return <div className="progress-strip analysis-status" role="status" aria-live="polite">{state.phase !== 'idle' && <span className="spinner"/>}{text}</div>;
}

function EmptyState({ onNew, onDemo }: { onNew: () => void; onDemo: () => void }) {
  return <div className="empty-home"><div className="empty-art"><div className="art-ring"/><span>幕</span></div><div className="eyebrow">A QUIET PLACE TO THINK</div><h1>手がかりと、<br/><em>次の一手を。</em></h1><p>シナリオ資料を残し、役の目的に沿った確認行動を並べます。<br/>まだ何もクラウドへ送らず、資料の保管から始められます。</p><div className="empty-actions"><button className="button button-ink" onClick={onNew}>＋ シナリオを作る</button><button className="button button-light" onClick={onDemo}>架空のデモを見る <span>↗</span></button></div><div className="empty-footnotes"><span><b>01</b> 資料はシナリオごとに保存</span><span><b>02</b> AIは自分で接続するまで未使用</span></div></div>;
}

function SectionHeading({ overline, title, note }: { overline: string; title: string; note?: string }) {
  return <div className="section-heading"><div><div className="eyebrow">{overline}</div><h2>{title}</h2></div>{note && <p>{note}</p>}</div>;
}

function Citation({ scenario, id, page, verification, onEvidence, action }: { scenario: Scenario; id: string; page?: string; verification?: string; onEvidence: OpenSource; action?: Action }) {
  const index = scenario.evidence.findIndex((item) => item.id === id);
  const source = action ? actionSource(scenario, action, id) : savedAnalysisSources(scenario).find((item) => item.id === id);
  const analysisIndex = sourceHistoryIndex(scenario, id);
  if (source) return <button className="citation-chip" onClick={() => action ? onEvidence(id, page, verification, undefined, { actionId: action.id }) : analysisIndex === undefined ? onEvidence(id, page, verification) : onEvidence(id, page, verification, analysisIndex)} title="解析に使った内容を開く">{source.title}{scenario.evidence.find((item) => item.id === id)?.analysisEnabled === false ? '（解析対象外）' : ''}　↗</button>;
  if (index < 0) return <span className="citation-missing">資料なし</span>;
  return <button className="citation-chip" onClick={() => action ? onEvidence(id, page, verification, undefined, { actionId: action.id }) : onEvidence(id, page, verification)} title="同じ画面で原本を開く">証拠 {String(index + 1).padStart(2, '0')}{page ? '　p.' + page : ''}　↗</button>;
}

function Citations({ scenario, ids, onEvidence, action }: { scenario: Scenario; ids: string[]; onEvidence: OpenSource; action?: Action }) {
  if (!ids?.length) return null;
  return <span className="citations">{ids.map((id) => <Citation key={id} scenario={scenario} id={id} onEvidence={onEvidence} action={action}/>)}</span>;
}

function Assumptions({ values }: { values?: string[] }) {
  if (!values?.length) return null;
  return <div className="assumption-note"><span>仮定（未確認）</span><p>{values.join('／')}</p></div>;
}

function ScopeBadge({ visibility }: { visibility: Visibility }) {
  return <span className={'scope-badge ' + scopeClass[visibility]}><span>{visibility === 'private' ? '◈' : visibility === 'shared' ? '◉' : '◇'}</span>{scopeLabel[visibility]}</span>;
}

function AnalysisChangeNotice({ scenario }: { scenario: Scenario }) {
  return scenario.analysis && scenario.analysis.revision < scenario.revision
    ? <p className="source-snapshot-note">変更は前回の解析へ未反映です。ここには前回の整理結果を表示しています。出典は保存当時の内容で開けます。</p> : null;
}

function Overview({ scenario, settings, busy, activeActions, onEdit, onPlans, onEvidence, onComplete, onDiscard, pendingActionIds = [] }: {
  scenario: Scenario; settings: AppSettings; busy: boolean; activeActions: Action[]; onEdit: () => void; onPlans: () => void;
  onEvidence: (id: string) => void; onComplete: (action: Action) => void; onDiscard: (action: Action) => void; pendingActionIds?: string[];
}) {
  const analysis = scenario.analysis;
  return <div className="page-stack">
    <AnalysisChangeNotice scenario={scenario}/>
    <div className="page-intro"><div><div className="eyebrow">SESSION OVERVIEW</div><h1>いま見えていること</h1><p>事実・読み取り・未確認を分け、行動の根拠へ戻れる形で整理します。</p></div><div className="intro-metrics"><div><span>{scenario.evidence.length.toString().padStart(2, '0')}</span><small>資料</small></div><div><span>{activeActions.length.toString().padStart(2, '0')}</span><small>次の行動</small></div></div></div>
    {!analysis && <div className="connect-note"><div className="connect-icon">✳</div><div><strong>AIは未接続です</strong><p>概要と証拠をこのPCに保存できます。資料に基づく状況整理と順位付き方針は、設定からAIを接続すると利用できます。未接続の状態では、こちらで内容を解析したようには表示しません。</p></div><button className="text-button" onClick={onEdit}>資料を追加 <span>→</span></button></div>}
    {analysis && <div className="overview-grid">
      <div className="overview-main">
        <section className="panel situation-panel">
          <div className="panel-top"><div><span className="panel-kicker"><span className="live-dot"/> CURRENT READ</span><h2>現在の流れ</h2></div><div className="panel-top-right"><span className="source-badge">{analysis.provider}</span><span className="tiny-date">{dateLabel(analysis.updatedAt)} 更新</span></div></div>
          <p className="situation-text">{analysis.overview}</p>
          <div className="situation-footer"><span>資料に基づく概括</span><button className="text-button" onClick={onPlans}>次の行動を見る <span>→</span></button></div>
        </section>
        <section className="panel event-panel">
          <div className="panel-top"><div><span className="panel-kicker">TIME / PEOPLE / EVENT</span><h2>時刻と出来事</h2></div><button className="text-button" onClick={onEdit}>原資料へ <span>→</span></button></div>
          {analysis.events?.length ? <div className="event-list">{analysis.events.slice(0, 5).map((event, index) => <EventRow key={index} event={event} scenario={scenario} onEvidence={onEvidence}/>)}</div> : <p className="muted-copy">イベント記録はまだありません。AI接続後の更新で資料ID・ページ・原文引用とともに整理します。</p>}
          {(analysis.events?.length || 0) > 5 && <button className="text-button event-more" onClick={onEdit}>すべてのイベントを見る <span>→</span></button>}
        </section>
        <div className="signal-grid">
          <SignalPanel type="fact" label="資料にある事実" count={analysis.facts?.length || 0} items={analysis.facts || []} scenario={scenario} onEvidence={onEvidence}/>
          <SignalPanel type="hypothesis" label="仮説・読み取り" count={analysis.hypotheses?.length || 0} items={analysis.hypotheses || []} scenario={scenario} onEvidence={onEvidence}/>
          <SignalPanel type="unknown" label="まだ未確認" count={analysis.unknowns?.length || 0} items={analysis.unknowns || []} scenario={scenario} onEvidence={onEvidence}/>
        </div>
      </div>
      <aside className="overview-rail">
        <section className="role-card">
          <div className="role-card-head"><span className="eyebrow">YOUR ROLE / GOAL</span><button onClick={onEdit} aria-label="役と目的を編集">↗</button></div>
          <div className="role-name">{scenario.roleProfile?.role || '役が未入力'}</div>
          <p>{scenario.roleProfile?.goal || '役の目的が分かると、質問の順番をあなたの狙いに合わせられます。'}</p>
          <div className="secret-row"><span>秘密</span><span>{scenario.roleProfile?.secret ? '登録済み' : '未登録'}</span><span className="secret-eye">◈</span></div>
          <div className="role-scope-note">{settings.includeRoleProfile ? '次回の解析に役・目的・秘密を含める設定です。' : '役プロフィールと役情報由来・由来不明の過去の整理結果は送信しません。HO内の役情報は資料の送信設定に従います。'}</div>
        </section>
        <section className="quick-plans">
          <div className="quick-plans-head"><div><span className="eyebrow">NEXT MOVES</span><h3>次に確かめること</h3></div><button onClick={onPlans}>すべて <span>→</span></button></div>
          {activeActions.length ? activeActions.slice(0, 3).map((action) => <div key={action.id} className="mini-action" data-action-id={action.id}><div className="mini-number">{String(action.priority).padStart(2, '0')}</div><div><strong>{action.title}</strong><span>{action.who || '相手は未特定'}</span><Assumptions values={action.assumptions}/><ActionCare action={action}/><RecheckNotes action={action}/><small>{action.rationale}</small><Citations scenario={scenario} ids={action.evidenceIds} onEvidence={onEvidence} action={action}/><ActionControls action={action} onComplete={onComplete} onDiscard={onDiscard} pending={pendingActionIds.includes(action.id)}/></div></div>) : <p className="muted-copy">有効な行動はありません。新しい資料を追加して更新してください。</p>}
          {activeActions.length > 0 && <button className="button button-green plan-open" onClick={onPlans}>行動の詳細を開く <span>↗</span></button>}
        </section>
        <section className="flow-footnote"><span className="footnote-mark">i</span><div><strong>情報の種類と公開範囲は別々</strong><p>事実・仮説・未確認は内容の確かさ。全体公開・自分だけ・不明は誰が知っているかの整理です。</p></div></section>
      </aside>
    </div>}
    {!analysis && <ScenarioSetupForm scenario={scenario} onSave={async (next) => { await next(); }} />}
  </div>;
}

function EventRow({ event, scenario, onEvidence }: { event: EventRecord; scenario: Scenario; onEvidence: OpenSource }) {
  const verification = event.quoteVerification || (/画像/.test(event.quoteOrigin || '') ? 'image_unverified' : 'legacy_text_matched');
  const analysisIndex = sourceHistoryIndex(scenario, event.sourceId);
  return <article className="event-row">
    <div className="event-time">{event.timeText || '時刻不明'}</div>
    <div className="event-main"><div className="event-line"><span className="event-type">{typeLabel(event.type)}</span><span className="event-people">{event.people?.length ? event.people.join(' ／ ') : '人物不明'}</span></div><p>{event.what}</p>
      {event.quote && <blockquote>{event.quote}<small>{quoteVerificationLabel(verification)}</small></blockquote>}
      {event.ambiguity && <div className="ambiguity-note"><span>?</span><span>要確認の曖昧さ</span> {event.ambiguity}</div>}
      <div className="event-cite"><Citation scenario={scenario} id={event.sourceId} page={event.page} verification={verification} onEvidence={onEvidence}/><button className="text-button source-open" onClick={() => onEvidence(event.sourceId, event.page, verification, analysisIndex)}>原本を開く ↗</button></div>
    </div>
  </article>;
}

function SignalPanel({ type, label, count, items, scenario, onEvidence }: { type: 'fact' | 'hypothesis' | 'unknown'; label: string; count: number; items: { statement?: string; question?: string; why?: string; evidenceIds: string[]; assumptions?: string[] }[]; scenario: Scenario; onEvidence: (id: string) => void }) {
  return <section className={'signal-panel signal-' + type}><div className="signal-head"><span className="signal-mark">{type === 'fact' ? '■' : type === 'hypothesis' ? '◧' : '○'}</span><span>{label}</span><span className="signal-count">{String(count).padStart(2, '0')}</span></div>
    {items.length ? items.slice(0, 3).map((item, index) => <div key={index} className="signal-item"><p>{item.statement || item.question}</p>{type === 'hypothesis' && <Assumptions values={item.assumptions}/>} {item.why && <small>{item.why}</small>}<Citations scenario={scenario} ids={item.evidenceIds || []} onEvidence={onEvidence}/></div>) : <p className="signal-empty">{type === 'fact' ? '資料に明記された事実はまだありません。' : type === 'hypothesis' ? '仮説・読み取りはまだありません。' : '未確認の問いはありません。'}</p>}
  </section>;
}

function ScenarioSetupForm({ scenario, onSave }: { scenario: Scenario; onSave: (next: () => Promise<void>) => void }) {
  return <div className="setup-reminder"><div className="setup-reminder-icon">✎</div><div><strong>シナリオ概要とあなたの目的を記録できます</strong><p>HOに書かれた役・目的は解析で読み取ります。別欄への補足は任意です。原資料は「資料を追加」へ保存します。</p></div></div>;
}

function EvidencePage({ scenario, title, setTitle, draft, setDraft, visibility, setVisibility, textSaving, profileSaving, onAddText, onAddFiles, onVisibility, selected, onSelect, preview, onPreview, onSource, onProfileSave, profile, setProfile, totalChars, totalBytes, retainedBytes = totalBytes, settings, candidates = [], onRemoveCandidate, onPaste, editFor, onEvidenceEdit, onEvidenceSave, onEvidenceEnabled }: {
  scenario: Scenario; title: string; setTitle: (value: string) => void; draft: string; setDraft: (value: string) => void; visibility: Visibility; setVisibility: (value: Visibility) => void;
  textSaving: boolean; profileSaving: boolean;
  onAddText: (event: FormEvent) => void; onAddFiles: () => void; onVisibility: (item: Evidence, value: Visibility) => void; selected: string; onSelect: (id: string) => void;
  preview: string; onPreview: (item: Evidence) => void; onSource?: OpenSource; onProfileSave: (event: FormEvent) => void; profile: { title: string; synopsis: string; role: string; goal: string; secret: string };
  setProfile: (value: { title: string; synopsis: string; role: string; goal: string; secret: string }) => void; totalChars: number; totalBytes: number; settings: AppSettings;
  retainedBytes?: number; candidates?: DraftCandidate[]; onRemoveCandidate?: (candidate: DraftCandidate) => void; onPaste?: (event: ClipboardEvent<HTMLFormElement>) => void;
  editFor?: (item: Evidence) => EvidenceEdit & { saving: boolean }; onEvidenceEdit?: (item: Evidence, patch: Partial<EvidenceEdit>) => void;
  onEvidenceSave?: (item: Evidence, event: FormEvent) => void; onEvidenceEnabled?: (item: Evidence) => void;
}) {
  return <div className="page-stack">
    <div className="page-intro"><div><div className="eyebrow">THE SOURCE SHELF</div><h1>資料を、原文のまま。</h1><p>文章を貼り付けるか、PDF・画像・テキストファイルをまとめて追加できます。</p></div><div className="intro-metrics"><div><span>{scenario.evidence.length.toString().padStart(2, '0')}</span><small>資料</small></div><div><span>{totalChars.toLocaleString()}</span><small>文字</small></div></div></div>
    <div className="evidence-layout">
      <div className="evidence-input-column">
        <form className="panel add-note-panel" onSubmit={onAddText} onPaste={onPaste} onKeyDown={(event) => {
          if (event.key !== 'Enter' || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
          if (event.ctrlKey || event.metaKey) { event.preventDefault(); event.currentTarget.requestSubmit(); }
          else if (event.target instanceof HTMLInputElement) event.preventDefault();
        }}>
          <div className="panel-top"><div><span className="panel-kicker">ADD A CLUE</span><h2>情報を追加</h2></div><span className="step-pill">01</span></div>
          <details className="intake-options"><summary>資料名・公開範囲 <span>必要なときだけ変更</span></summary>
            <label className="field-label">見出し <span>空欄なら本文から補完</span><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="例：食堂で聞いたこと"/></label>
            <VisibilitySelect value={visibility} onChange={setVisibility}/>
          </details>
          <label className="field-label">本文 <span>原文のまま保存</span><textarea value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="会話、配布情報、気づいたことを貼り付けます。時刻や言い回しはそのまま残ります。" rows={8}/></label>
          <button className="drop-zone" type="button" onClick={onAddFiles}><span className="upload-mark">↥</span><strong>ファイルを選択</strong><small>複数選択できます　·　PDF / PNG / JPG / WebP / TXT / MD</small></button>
          <div className="paste-tip"><span>⌘</span><div><strong>この窓口に画像を貼り付け</strong><small>文章・ファイル・画像は、追加ボタンまたはCtrl+Enterでまとめて確定します。入力途中ではAIへ送りません。</small></div></div>
          {!!candidates.length && <ul className="intake-candidates">{candidates.map((item, index) => <li key={item.id} data-candidate-id={item.id}>
            {item.dataUrl && <img src={item.dataUrl} alt={'追加候補 ' + (index + 1)}/>}
            <div><strong>{item.name}</strong><small>{bytesLabel(item.byteSize)}{item.loading ? '・読込中' : ''}</small>{item.error && <span role="alert">{item.error}</span>}</div>
            <button type="button" disabled={textSaving} onClick={() => onRemoveCandidate?.(item)} aria-label={item.name + 'を候補から外す'}>×</button>
          </li>)}</ul>}
          <button className="button button-ink full-button" type="submit" disabled={textSaving || (!draft.trim() && !candidates.length) || candidates.some((item) => item.loading || item.error)}>{textSaving ? '保存中…' : '資料に追加'} <span>→</span></button>
          <div className="retention-meter"><div className="meter-copy"><span>解析対象の添付</span><strong>{bytesLabel(totalBytes)} <small>/ 40MiB</small></strong></div><div className="meter-track"><span style={{ width: Math.min(100, totalBytes / (40 * 1024 * 1024) * 100) + '%' }}/></div><p>保存済み原本 {bytesLabel(retainedBytes)}。解析本文 {totalChars.toLocaleString()} / {settings.textLimitCharacters.toLocaleString()}文字。1ファイル20MiBまで取り込めます。上限を超えたら、資料一覧で編集するか解析対象から外して再開できます。</p></div>
        </form>
        <form className="panel profile-panel" onSubmit={onProfileSave}>
          <div className="panel-top"><div><span className="panel-kicker">MY CHARACTER</span><h2>自分の役と目的</h2></div><span className="lock-icon">◈</span></div>
          <p className="panel-subcopy">HOの役・目的は解析で読み取るため、ここへの再入力は不要です。補足したいことがあれば任意で保存できます。</p>
          <label className="field-label">シナリオ名<input value={profile.title} onChange={(event) => setProfile({ ...profile, title: event.target.value })}/></label>
          <label className="field-label">シナリオ概要<textarea rows={4} value={profile.synopsis} onChange={(event) => setProfile({ ...profile, synopsis: event.target.value })} placeholder="場面、登場人物、進行上の前提など。大事な情報を削らずに保存します。"/></label>
          <details className="role-details" open>
            <summary>自分の役・秘密を追加 <span>ローカル保存</span></summary>
            <label className="field-label">役名<input value={profile.role} onChange={(event) => setProfile({ ...profile, role: event.target.value })} placeholder="未設定なら空欄のまま"/></label>
            <label className="field-label">達成したい目的<textarea rows={2} value={profile.goal} onChange={(event) => setProfile({ ...profile, goal: event.target.value })} placeholder="例：疑いを避ける／大切な人物を守る／交渉を成立させる"/></label>
            <label className="field-label">自分だけの秘密<textarea rows={2} value={profile.secret} onChange={(event) => setProfile({ ...profile, secret: event.target.value })} placeholder="必要なとき、分析に含めるかは設定から選べます。"/></label>
          </details>
          <button className="button button-green full-button" type="submit" disabled={profileSaving}>シナリオ情報を保存</button>
        </form>
      </div>
      <div className="evidence-list-column">
        {savedAnalysisSources(scenario).filter((source) => source.id === selected && !scenario.evidence.some((item) => item.id === source.id)).map((source, index) => <article key={source.id + '-' + index} id={'evidence-' + source.id + (index ? '-' + index : '')} className="evidence-card selected">
          <div className="evidence-card-head"><strong>{source.title}</strong><ScopeBadge visibility={source.visibility}/></div>
          <div className="evidence-detail"><p className="muted-copy">解析に使った内容</p><pre className="raw-source">{source.extractedText}</pre></div>
        </article>)}
        <div className="evidence-list-head"><div><span className="eyebrow">SAVED MATERIALS</span><h2>資料一覧 <span>{scenario.evidence.length}</span></h2></div><span className="scope-reminder">公開範囲は資料ごと</span></div>
        {scenario.analysis && scenario.analysis.revision < scenario.revision && <p className="source-snapshot-note">資料の変更は前回の解析へ未反映です。前回の出典は保存当時の内容で開けます。</p>}
        {scenario.evidence.length ? <div className="evidence-cards">{scenario.evidence.map((item, index) => <EvidenceCard key={item.id} item={item} index={index} selected={selected === item.id} preview={preview} onSelect={() => onSelect(selected === item.id ? '' : item.id)} onVisibility={onVisibility} onPreview={onPreview} onSource={onSource} provider={settings.provider} edit={editFor?.(item)} onEdit={onEvidenceEdit} onSave={onEvidenceSave} onEnabled={onEvidenceEnabled}/>)}</div> : <div className="no-evidence"><div className="no-evidence-mark">＋</div><strong>まだ資料はありません</strong><p>テキストを貼り付けるか、PDFやスクリーンショットを追加します。</p></div>}
        <div className="preserve-note"><span>◈</span><p><strong>原本は要約で置き換わりません。</strong><br/>AIの概要・イベント表は参照用の索引です。原文と添付ファイルは別に保存し続けます。</p></div>
      </div>
    </div>
  </div>;
}

function VisibilitySelect({ value, onChange }: { value: Visibility; onChange: (value: Visibility) => void }) {
  return <label className="visibility-field"><span>この情報を知っている範囲</span><select value={value} onChange={(event) => onChange(event.target.value as Visibility)}><option value="unknown">公開状況不明</option><option value="shared">全体公開</option><option value="private">自分だけ</option></select></label>;
}

function EvidenceCard({ item, index, selected, preview, onSelect, onVisibility, onPreview, onSource, provider, edit, onEdit, onSave, onEnabled }: { item: Evidence; index: number; selected: boolean; preview: string; onSelect: () => void; onVisibility: (item: Evidence, value: Visibility) => void; onPreview: (item: Evidence) => void; onSource?: OpenSource; provider?: AppSettings['provider']; edit?: EvidenceEdit & { saving: boolean }; onEdit?: (item: Evidence, patch: Partial<EvidenceEdit>) => void; onSave?: (item: Evidence, event: FormEvent) => void; onEnabled?: (item: Evidence) => void }) {
  const kindLabel = item.kind === 'pdf' ? 'PDF' : item.kind === 'image' ? 'IMAGE' : 'TEXT';
  const extractionError = item.extractionStatus === 'error' || item.extractionStatus === 'partial';
  return <article id={'evidence-' + item.id} className={'evidence-card ' + (selected ? 'selected' : '')}>
    <div className="evidence-card-head"><div className={'file-mark file-' + item.kind}>{item.kind === 'pdf' ? 'PDF' : item.kind === 'image' ? '▧' : 'T'}</div><div className="evidence-title-block"><div className="evidence-title-row"><span className="evidence-index">{String(index + 1).padStart(2, '0')}</span><strong>{item.title}</strong><span className="kind-label">{kindLabel}</span></div><span className="evidence-date">追加 {dateLabel(item.createdAt)}{item.byteSize ? '　·　' + bytesLabel(item.byteSize) : ''}</span></div>
      <div className="evidence-scope"><ScopeBadge visibility={item.visibility}/>{item.analysisEnabled === false && <span className="scope-badge scope-unknown">解析対象外</span>}</div>
    </div>
    {item.kind === 'pdf' && <>
      <div className={'extract-status ' + (extractionError ? 'extract-warning' : 'extract-ok')}><span>{extractionError ? '!' : '·'}</span>{item.extractionMessage || (item.pdfPages ? 'ページ別の抽出状態を保存しました。' : '旧形式の抽出情報。原本を開くとページ別の状態を確認できます。')}</div>
      {provider === 'ollama' && <p className="image-note">Ollamaには抽出本文だけを送ります。PDF画像は解析対象外です。</p>}
      {item.pdfPages && <details className="pdf-page-states"><summary>ページ別の状態（{item.pdfPageCount ?? 'ページ数不明'}）</summary><ol>{item.pdfPages.map((page) => <li key={page.pageNumber}>{onSource ? <button className="text-button" onClick={() => onSource(item.id, String(page.pageNumber), undefined, undefined, { current: true })}>p.{page.pageNumber}</button> : 'p.' + page.pageNumber}　{page.extractionStatus === 'success' ? '本文抽出あり' : page.extractionStatus === 'no_text' ? '本文抽出なし' : '本文抽出エラー'}{page.hasImages ? '・画像あり' : ''}{page.extractionMessage ? ' — ' + page.extractionMessage : ''}</li>)}</ol></details>}
    </>}
    {item.kind === 'image' && <div className="image-note">画像本体を保存しました。OpenAI解析では画像として送ります。Ollamaでは選んだモデルがVision対応か未確認です。</div>}
    {onSource && <button className="text-button evidence-source-open" onClick={() => onSource(item.id, undefined, undefined, undefined, { current: true })}>同じ画面で原本を開く ↗</button>}
    <button className="evidence-toggle" onClick={onSelect}>{selected ? '資料の詳細を閉じる' : item.extractedText ? '抽出テキスト・原文を表示' : '原本の詳細を表示'} <span>{selected ? '−' : '+'}</span></button>
    {selected && <div className="evidence-detail">
      <button type="button" className="button button-light evidence-enabled" onClick={() => onEnabled?.(item)}>{item.analysisEnabled === false ? '解析対象に戻す' : '解析対象から外す'}</button>
      <details className="evidence-edit"><summary>見出し・本文を編集 <span>原本を保持</span></summary>
        <form onSubmit={(event) => onSave?.(item, event)} onKeyDown={(event) => {
          if (event.key !== 'Enter' || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
          if (event.ctrlKey || event.metaKey) { event.preventDefault(); event.currentTarget.requestSubmit(); }
          else if (event.target instanceof HTMLInputElement) event.preventDefault();
        }}>
          <label className="field-label">見出し<input value={edit?.title ?? item.title} onChange={(event) => onEdit?.(item, { title: event.target.value })}/></label>
          <label className="field-label">解析に使う本文<textarea rows={6} value={edit?.text ?? evidenceBody(item)} onChange={(event) => onEdit?.(item, { text: event.target.value })}/></label>
          <p className="muted-copy">原本と最初の本文は残ります。編集本文からの引用は原本照合済みとは扱いません。</p>
          <button className="button button-ink" type="submit" disabled={edit?.saving}>{edit?.saving ? '保存中…' : '編集を保存'}</button>
        </form>
        <VisibilitySelect value={item.visibility} onChange={(value) => onVisibility(item, value)}/>
      </details>
      {item.editedText !== undefined && <div className="edited-source"><p className="muted-copy">編集した本文（原本未照合）</p><pre className="raw-source">{item.editedText || '本文なし'}</pre></div>}
      {item.kind === 'image' && <div className="preview-holder">{preview ? <img src={preview} alt={item.title + ' のプレビュー'}/> : <button className="button button-light" onClick={() => onPreview(item)}>画像をプレビュー</button>}</div>}
      {item.extractedText ? <pre className="raw-source">{item.extractedText}</pre> : item.kind === 'pdf' ? <p className="muted-copy">文字抽出はありません。PDF原本は保存されています。OpenAI APIならPDFのページ画像も解析できます。Ollamaは抽出できた文字だけを使い、ページ画像は送信しません。</p> : item.kind === 'image' ? <p className="muted-copy">この画像から文字はまだ抽出していません。AIを接続すると、選択したモデルが画像を読める場合に解析します。</p> : <p className="muted-copy">本文なし</p>}
      {item.attachmentPath && <div className="attachment-path">原本保存済み　·　{item.originalName}</div>}
    </div>}
  </article>;
}

function ActionControls({ action, onComplete, onDiscard, pending = false }: { action: Action; onComplete: (action: Action) => void; onDiscard: (action: Action) => void; pending?: boolean }) {
  return <div className="action-controls"><button type="button" className="text-button" onClick={() => onComplete(action)} disabled={pending}>✓ 完了</button><button type="button" className="text-button danger-link" onClick={() => onDiscard(action)} disabled={pending}>見送る</button></div>;
}

function ActionCare({ action }: { action: Action }) {
  return <div className="action-care"><span>秘密への配慮</span><p>{action.secretRisk?.trim() || '配慮の記載はありません。発言内容は未確認です。'}</p></div>;
}

function RecheckNotes({ action }: { action: Action }) {
  if (!action.rechecks?.length) return null;
  return <div className="action-rechecks">{action.rechecks.map((item) => <div key={item.actionId}><strong>再確認 · 前提の変化</strong><p>以前: {item.previousPremise}</p><p>今回: {item.currentPremise}</p><p>{item.reason}</p></div>)}</div>;
}

function ActionSourceScope({ scenario, action }: { scenario: Scenario; action: Action }) {
  return <div className="action-source-scope"><span>根拠資料の公開範囲</span>{action.evidenceIds?.length ? <ScopeBadge visibility={getActionVisibility(scenario, action)}/> : <span className="scope-badge scope-unknown">参照資料なし</span>}</div>;
}

function PlansPage({ scenario, actions, settings, busy, onAnalyze, onEvidence, onComplete, onDiscard, pendingActionIds = [] }: {
  scenario: Scenario; actions: Action[]; settings: AppSettings; busy: boolean; onAnalyze: () => void; onEvidence: (id: string) => void; onComplete: (action: Action) => void; onDiscard: (action: Action) => void; pendingActionIds?: string[];
}) {
  return <div className="page-stack">
    <AnalysisChangeNotice scenario={scenario}/>
    <div className="page-intro"><div><div className="eyebrow">ACTIONS TO TAKE</div><h1>次に確かめること</h1><p>数字は優先順です。犯人らしさの確率ではありません。</p></div><div className="intro-metrics"><div><span>{actions.length.toString().padStart(2, '0')}</span><small>有効な方針</small></div></div></div>
    <div className="plans-context"><div className="plan-context-icon">↗</div><div><span className="eyebrow">WHY THIS ORDER</span><strong>{scenario.roleProfile?.goal || 'HOに役・目的があれば解析で利用します。補足の入力は任意です。'}</strong><p>誰に何を聞くか、秘密への配慮を先に確認できます。目的や出典は詳細から読めます。</p></div><button className="button button-light" onClick={onAnalyze} disabled={busy}>{busy ? '更新中…' : 'もう一度解析'}</button></div>
    {scenario.analysis && <div className="strategy-summary"><span>現在地</span><p>{scenario.analysis.overview}</p><div><span>解析モデル: {scenario.analysis.provider}</span><span>更新 {dateLabel(scenario.analysis.updatedAt)}</span>{scenario.analysis.usage?.input_tokens != null && <span>入力 {scenario.analysis.usage.input_tokens.toLocaleString()} / 出力 {(scenario.analysis.usage.output_tokens || 0).toLocaleString()} tokens</span>}</div></div>}
    {actions.length ? <div className="action-list">{actions.map((action) => <article className="action-card" key={action.id} data-action-id={action.id}>
      <div className="action-rank"><span>優先</span><strong>{String(action.priority).padStart(2, '0')}</strong></div>
      <div className="action-body"><div className="action-heading"><div><span className="action-kicker">NEXT ACTION</span><h2>{action.title}</h2></div><ActionSourceScope scenario={scenario} action={action}/></div>
        <div className="action-one-line"><span>誰へ</span><strong>{action.who || '相手は資料から特定できていない'}</strong><span className="action-step">{action.step}</span></div>
        <Assumptions values={action.assumptions}/>
        {action.suggestedLine && <p className="action-suggested-line">発言例: {action.suggestedLine}</p>}
        <ActionCare action={action}/><RecheckNotes action={action}/>
        <details className="action-details"><summary>理由・目的・出典の詳細 <span>詳細を開く　＋</span></summary>
          <div className="action-detail-grid"><div className="detail-cell"><span>優先する理由</span><p>{action.rationale}</p></div><div className="detail-cell"><span>目的への寄与</span><p>{action.purpose || '目的とのつながりは未確認です。'}</p></div></div>
          {!!action.evidenceIds?.length && <div className="action-source-line"><span>参照資料</span><Citations scenario={scenario} ids={action.evidenceIds} onEvidence={onEvidence} action={action}/></div>}
        </details>
        <ActionControls action={action} onComplete={onComplete} onDiscard={onDiscard} pending={pendingActionIds.includes(action.id)}/>
      </div>
    </article>)}</div> : <div className="no-evidence no-actions"><div className="no-evidence-mark">↗</div><strong>{scenario.analysis ? '現在有効な方針はありません' : '資料から優先行動を作ります'}</strong><p>{scenario.analysis ? '過去の方針は履歴に残っています。新しい資料で状況を更新できます。' : 'AI未接続なら設定から接続するか、資料を先に登録してください。'}</p><button className="button button-ink" onClick={onAnalyze} disabled={busy}>{busy ? '解析中…' : '状況を解析する'}</button></div>}
    {settings.provider === 'none' && <div className="plain-mode-note"><span>i</span>AI未接続のとき、アプリは行動を自動生成しません。方針はAI接続後に資料から提案されます。</div>}
  </div>;
}

function getActionVisibility(scenario: Scenario, action: Action): Visibility {
  const scopes = (action.evidenceIds || []).map((id) => (scenario.evidence.find((item) => item.id === id) || action.sourceSnapshots?.find((item) => item.id === id) || savedAnalysisSources(scenario).find((item) => item.id === id))?.visibility || 'unknown');
  if (scopes.includes('private')) return 'private';
  if (!scopes.length || scopes.includes('unknown')) return 'unknown';
  return 'shared';
}

function HistoryNoteEditor({ action, notes, onChange, onSave, pending = false }: { action: Action; notes: ActionNotes; onChange: (notes: ActionNotes) => void; onSave: (notes: ActionNotes) => void; pending?: boolean }) {
  return <details className="history-note-editor"><summary>理由・得た回答をメモする（任意）</summary><form onSubmit={(event) => { event.preventDefault(); if (!pending) onSave({ ...notes }); }}>
    <label>{action.status === 'discarded' ? '見送り理由（任意）' : '補足・理由（任意）'}<textarea rows={2} value={notes.reason} onChange={(event) => onChange({ ...notes, reason: event.target.value })}/></label>
    <label>得た回答（任意・履歴メモ）<textarea rows={2} value={notes.resultNote} onChange={(event) => onChange({ ...notes, resultNote: event.target.value })}/></label>
    <button type="submit" className="button button-light" disabled={pending}>{pending ? '保存中…' : '任意のメモを保存'}</button>
  </form></details>;
}

function HistoryPage({ scenario, history, onRestore, onEvidence, notesFor, onNotesChange, onNotesSave, pendingActionIds = [] }: {
  scenario: Scenario; history: Action[]; onRestore: (action: Action) => void; onEvidence: (id: string) => void;
  notesFor?: (action: Action) => ActionNotes; onNotesChange?: (action: Action, notes: ActionNotes) => void; onNotesSave?: (action: Action, notes: ActionNotes) => void; pendingActionIds?: string[];
}) {
  const label = (status: string) => status === 'discarded' ? '見送り' : status === 'completed' ? '完了' : status === 'restored' ? '履歴から復帰' : '更新で置き換え';
  return <div className="page-stack">
    <div className="page-intro"><div><div className="eyebrow">DECISION TRAIL</div><h1>方針の履歴</h1><p>完了・見送り・解析更新で外れた行動を、日時とつながりごとに残します。理由と得た回答は任意です。</p></div><div className="intro-metrics"><div><span>{history.length.toString().padStart(2, '0')}</span><small>記録</small></div></div></div>
    {history.length ? <div className="history-list">{[...history].reverse().map((action, index) => <article className="history-card" key={scenario.id + '/' + action.id + '-' + index} data-history-id={action.id}>
      <div className="history-status"><span className={'history-mark status-' + action.status}>{action.status === 'completed' ? '✓' : action.status === 'discarded' ? '×' : '↶'}</span><div><strong>{label(action.status)}</strong><small>{dateLabel(action.retiredAt || action.updatedAt || action.createdAt)}</small></div></div>
      <div className="history-main"><h3>{action.title}</h3><Assumptions values={action.assumptions}/><p>{action.retirementReason || '理由のメモはありません。'}</p>{action.resultNote && <p>得た回答: {action.resultNote}</p>}<RecheckNotes action={action}/><details><summary>保存した方針を見る</summary><p>{action.step}</p><p>{action.suggestedLine}</p><p>{action.purpose}</p><p>{action.rationale}</p><p>{action.secretRisk}</p></details><div className="history-meta"><span>対象: {action.who || '未特定'}</span><Citations scenario={scenario} ids={action.evidenceIds} onEvidence={onEvidence} action={action}/></div>
        {['completed', 'discarded'].includes(action.status) && onNotesSave && <HistoryNoteEditor action={action} notes={notesFor?.(action) || { reason: action.retirementReason || '', resultNote: action.resultNote || '' }} onChange={(notes) => onNotesChange?.(action, notes)} onSave={(notes) => onNotesSave(action, notes)} pending={pendingActionIds.includes(action.id)}/>}
      </div>
      {action.status === 'discarded' && <button className="button button-light restore-button" onClick={() => onRestore(action)} disabled={pendingActionIds.includes(action.id)}>明示的に復帰</button>}
    </article>)}</div> : <div className="no-evidence"><div className="no-evidence-mark">↶</div><strong>まだ履歴はありません</strong><p>行動を完了・見送り・置き換えにしたとき、ここに内容と日時が残ります。</p></div>}
    {(scenario.analysisHistory || []).slice().reverse().map((analysis, index) => <details className="panel previous-analysis" key={analysis.revision + '-' + index}>
      <summary>保存した以前の整理結果 · {dateLabel(analysis.updatedAt)}</summary>
      <p className="muted-copy">変更前の内容をこのPCで閲覧できます。資料の除外設定を反映し、役情報由来・由来不明の文章は役情報OFFの解析には送信しません。</p>
      <p>{analysis.overview}</p>
      {(analysis.flow || []).map((item, itemIndex) => <p key={'flow-' + itemIndex}>{item.moment} · {item.summary}</p>)}
      {(analysis.events || []).map((event, eventIndex) => <EventRow key={'event-' + eventIndex} event={event} scenario={{ ...scenario, analysis }} onEvidence={onEvidence}/>)}
      <h4>資料にある事実</h4>{(analysis.facts || []).map((item, itemIndex) => <p key={'fact-' + itemIndex}>{item.statement} <Citations scenario={{ ...scenario, analysis }} ids={item.evidenceIds} onEvidence={onEvidence}/></p>)}
      <h4>仮説・読み取り</h4>{(analysis.hypotheses || []).map((item, itemIndex) => <div key={'hypothesis-' + itemIndex}><p>{item.statement}</p><p>{item.why}</p><Assumptions values={item.assumptions}/><Citations scenario={{ ...scenario, analysis }} ids={item.evidenceIds} onEvidence={onEvidence}/></div>)}
      <h4>まだ未確認</h4>{(analysis.unknowns || []).map((item, itemIndex) => <p key={'unknown-' + itemIndex}>{item.question} · {item.why} <Citations scenario={{ ...scenario, analysis }} ids={item.evidenceIds} onEvidence={onEvidence}/></p>)}
      <h4>その時の方針</h4>{(analysis.actions || []).map((action, actionIndex) => <details key={action.id + '-' + actionIndex}><summary>{action.title} · {action.who || '対象未特定'}</summary><p>{action.step}</p><p>{action.suggestedLine}</p><p>{action.purpose}</p><p>{action.rationale}</p><p>{action.secretRisk}</p><Assumptions values={action.assumptions}/><Citations scenario={{ ...scenario, analysis }} ids={action.evidenceIds} onEvidence={onEvidence}/></details>)}
    </details>)}
  </div>;
}

function SettingsPage({ settings, onSettings, onSaved, onCodexStatus, codexStatus, onDataFolder, onError, onDelete, scenario }: {
  settings: AppSettings; onSettings: (value: AppSettings) => void; onSaved: (value: AppSettings) => void; onCodexStatus: (status: CodexConnectionStatus | null) => void; codexStatus: CodexConnectionStatus | null; onDataFolder: () => void; onError: (reason: unknown) => void; onDelete: () => void; scenario: Scenario | null;
}) {
  const [draft, setDraft] = useState({ ...settings });
  const [apiKey, setApiKey] = useState('');
  const [removeKey, setRemoveKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState('');
  const [loginCode, setLoginCode] = useState<{ verificationUrl: string; userCode: string } | null>(null);

  useEffect(() => { setDraft({ ...settings }); }, [settings]);

  const set = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => setDraft((current) => ({ ...current, [key]: value }));
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (draft.provider === 'codex' && codexStatus?.models.length && draft.codexModel
      && !codexStatus.models.some((model) => model.id === draft.codexModel)) {
      setTestResult('保存済みのCodexモデルは現在利用できません。接続状態を確認し、一覧から利用可能なモデルを選び直してください。');
      return;
    }
    setSaving(true);
    try {
      const result = await window.makua.saveSettings({ ...draft, apiKey, removeKey });
      onSaved(result);
      onSettings(result);
      setApiKey('');
      setRemoveKey(false);
      setTestResult(result.autoUpdate && result.provider !== 'none' ? '設定を保存しました。自動更新がONのため、次の資料変更から解析します。' : '設定を保存しました。設定保存だけではAIリクエストを送りません。');
    } catch (reason) { onError(reason); }
    finally { setSaving(false); }
  };
  const test = async () => {
    setTesting(true);
    setTestResult('接続を確認しています…');
    try {
      const result = await window.makua.testAi({ provider: draft.provider, codexCliPath: draft.codexCliPath });
      setTestResult(result.message);
      if (result.codexStatus) {
        onCodexStatus(result.codexStatus);
        const selected = result.codexStatus.models.find((model) => model.id === draft.codexModel)
          || result.codexStatus.models.find((model) => model.isDefault);
        if (selected) setDraft((current) => ({ ...current, codexModel: current.codexModel || selected.id, codexEffort: current.codexEffort || selected.defaultEffort || selected.supportedEfforts[0] || '' }));
      }
    } catch (reason) { setTestResult(String((reason as Error)?.message || reason)); }
    finally { setTesting(false); }
  };
  const startCodexLogin = async () => {
    setTesting(true);
    setLoginCode(null);
    setTestResult('公式Codexのサインイン状態を確認しています…');
    try {
      const result = await window.makua.startCodexLogin(draft.codexCliPath);
      setTestResult(result.message);
      if (result.ok && result.verificationUrl && result.userCode) setLoginCode({ verificationUrl: result.verificationUrl, userCode: result.userCode });
    } catch (reason) { setTestResult(String((reason as Error)?.message || reason)); }
    finally { setTesting(false); }
  };
  const cancelCodexLogin = async () => {
    setTesting(true);
    try {
      const result = await window.makua.cancelCodexLogin();
      setTestResult(result.message);
      setLoginCode(null);
    } catch (reason) { setTestResult(String((reason as Error)?.message || reason)); }
    finally { setTesting(false); }
  };
  const chooseCodexCli = async () => {
    try {
      const result = await window.makua.chooseCodexCli();
      if (!result.canceled && result.path) set('codexCliPath', result.path);
    } catch (reason) { onError(reason); }
  };

  const selectedCodexModel = codexStatus?.models.find((model) => model.id === draft.codexModel)
    || (!draft.codexModel ? codexStatus?.models.find((model) => model.isDefault) : undefined);
  const codexModelUnavailable = Boolean(draft.codexModel && codexStatus?.models.length
    && !codexStatus.models.some((model) => model.id === draft.codexModel));
  const codexUsage = codexStatus?.rateLimit;

  return <div className="page-stack settings-page">
    <div className="page-intro"><div><div className="eyebrow">PRIVATE BY DEFAULT</div><h1>接続と保存の設定</h1><p>AIは自分で接続するまで未使用です。解析対象と送信先はここで確認できます。</p></div><div className="intro-metrics settings-metric"><div><span>{settings.provider === 'none' ? 'OFF' : settings.provider === 'openai' ? 'API' : settings.provider === 'codex' ? 'CODEX' : 'LOCAL'}</span><small>AI状態</small></div></div></div>
    <form onSubmit={save} className="settings-form">
      <section className="panel settings-panel provider-panel"><div className="panel-top"><div><span className="panel-kicker">01 / ANALYSIS PROVIDER</span><h2>解析に使うAI</h2></div><span className="step-pill">任意</span></div>
        <div className="provider-options">
          <button type="button" className={'provider-option ' + (draft.provider === 'none' ? 'chosen' : '')} onClick={() => setDraft((current) => ({ ...current, provider: 'none', autoUpdate: false }))}><span className="provider-icon">◌</span><strong>未接続</strong><small>保存と資料整理のみ。解析は実行しません。</small></button>
          <button type="button" className={'provider-option ' + (draft.provider === 'openai' ? 'chosen' : '')} onClick={() => setDraft((current) => ({ ...current, provider: 'openai', autoUpdate: false }))}><span className="provider-icon">✳</span><strong>OpenAI API</strong><small>外部送信。画像とPDFページも解析できます。</small></button>
          <button type="button" className={'provider-option ' + (draft.provider === 'ollama' ? 'chosen' : '')} onClick={() => setDraft((current) => ({ ...current, provider: 'ollama', autoUpdate: false }))}><span className="provider-icon">⌂</span><strong>Ollama ローカル</strong><small>このPCのlocalhostだけ。モデルは自分で用意します。</small></button>
          <button type="button" className={'provider-option ' + (draft.provider === 'codex' ? 'chosen' : '')} onClick={() => setDraft((current) => ({ ...current, provider: 'codex', autoUpdate: false }))}><span className="provider-icon">◈</span><strong>Codex（ChatGPTの契約枠）</strong><small>専用profileのChatGPTサインインを使用。APIキーとは別です。</small></button>
        </div>
        {draft.provider === 'openai' && <div className="provider-fields">
          <div className="settings-fields-row"><label className="field-label">モデル<select value={draft.model} onChange={(event) => set('model', event.target.value)}><option value="gpt-6-luna">GPT-6 Luna　· 低コストの標準</option><option value="gpt-6-sol">GPT-6 Sol　· 中間</option><option value="gpt-6-astra">GPT-6 Astra　· 高性能</option></select></label><label className="field-label">推論強度<select value={draft.effort} onChange={(event) => set('effort', event.target.value)}>{(draft.model === 'gpt-6-astra' ? ['low', 'medium', 'high', 'xhigh', 'max'] : ['none', 'low', 'medium', 'high', 'xhigh', 'max']).map((value) => <option value={value} key={value}>{value}</option>)}</select></label></div>
          <label className="field-label">OpenAI APIキー <span>{settings.hasKey ? '登録済み · 変更時だけ入力' : '未登録'}</span><input type="password" autoComplete="new-password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={settings.hasKey ? '保存済みキーは表示しません' : 'sk-…'} /></label>
          <div className="privacy-callout"><span>◈</span><div><strong>キーはWindowsの暗号化ストレージに保存</strong><p>キーを画面へ再表示せず、ソース・ログ・バックアップには含めません。アプリはOpenAI APIへ直接接続します。</p></div></div>
          {settings.hasKey && <label className="checkbox-row danger-check"><input type="checkbox" checked={removeKey} onChange={(event) => setRemoveKey(event.target.checked)}/>保存済みのAPIキーを削除</label>}
          <div className="pricing-note"><strong>費用の目安（公式単価）</strong><p>Lunaは入力 $0.10 / 出力 $0.50、Solは $2 / $10、Astraは $10 / $50（100万トークンあたり）。画像・PDFページは追加の入力トークンになり、実際の請求額は送信量と利用状況で変わります。速度はこのPCから実測していません。</p><small>標準は低コストのGPT-6 Luna / medium。モデルはいつでも切替でき、上位モデルへ自動昇格しません。</small></div>
          <label className="checkbox-row consent-row"><input type="checkbox" checked={draft.cloudConsent} onChange={(event) => set('cloudConsent', event.target.checked)}/><span><strong>OpenAIへ資料を送ることを理解しました。</strong><small>シナリオ概要・全テキスト資料・PDF原本・画像に加え、役情報の送信設定で許可された有効方針・仮説・行動履歴（完了・見送り・更新、任意メモ）を送信します。プロフィールと過去の整理結果の送信範囲は下の設定に従います。接続テストと解析はAPI利用料がかかる場合があります。</small></span></label>
        </div>}
        {draft.provider === 'ollama' && <div className="provider-fields"><div className="settings-fields-row"><label className="field-label">localhost URL<input value={draft.ollamaUrl} onChange={(event) => set('ollamaUrl', event.target.value)} placeholder="http://localhost:11434"/></label><label className="field-label">モデル名<input value={draft.ollamaModel} onChange={(event) => set('ollamaModel', event.target.value)} placeholder="インストール済みのモデル名"/></label></div><div className="privacy-callout"><span>⌂</span><div><strong>ローカル接続として確認するのはlocalhostのみ</strong><p>画像は選択モデルへ送りますが、モデルごとのVision対応は自動判定していません。PDFはローカル抽出できたテキストだけを送り、ページ画像は解析しません。</p></div></div></div>}
        {draft.provider === 'codex' && <div className="provider-fields codex-fields">
          <div className="settings-fields-row codex-cli-row"><label className="field-label">公式Codex CLIの場所<span>自動検出できない場合だけ指定</span><input value={draft.codexCliPath} onChange={(event) => set('codexCliPath', event.target.value)} placeholder="codex.exe の場所を選択" /></label><button type="button" className="button button-light codex-browse" onClick={chooseCodexCli}>codex.exeを選ぶ…</button></div>
          <div className="settings-fields-row"><label className="field-label">Codexモデル<select value={draft.codexModel} onChange={(event) => {
            const model = codexStatus?.models.find((entry) => entry.id === event.target.value);
            setDraft((current) => ({ ...current, codexModel: event.target.value, codexEffort: model?.defaultEffort || model?.supportedEfforts[0] || '' }));
          }} disabled={!codexStatus?.models.length}>
            {!codexStatus?.models.length && <option value="">接続状態を確認して一覧を取得</option>}
            {codexModelUnavailable && <option value={draft.codexModel} disabled>保存済みモデルは現在の一覧にありません</option>}
            {codexStatus?.models.map((model) => <option value={model.id} key={model.id}>{model.displayName}{model.isDefault ? ' · 標準' : ''}{model.inputModalities.includes('image') ? ' · 画像対応' : ''}</option>)}
          </select></label><label className="field-label">推論強度<select value={draft.codexEffort} onChange={(event) => set('codexEffort', event.target.value)} disabled={!selectedCodexModel?.supportedEfforts.length}>{(selectedCodexModel?.supportedEfforts || []).map((effort) => <option value={effort} key={effort}>{effort}</option>)}{!selectedCodexModel?.supportedEfforts.length && <option value="">モデル情報が必要</option>}</select></label></div>
          {codexModelUnavailable && <div className="privacy-callout"><span>!</span><div><strong>保存済みモデルを利用できません</strong><p>一覧にあるモデルを選び直してください。アプリは別モデルへ自動で切り替えません。</p></div></div>}
          <div className="codex-connection-row"><div><strong>{codexStatus?.ready ? '接続済み' : codexStatus?.authenticated ? 'サインイン済み・モデル未確認' : '接続状態未確認'}</strong><small>{codexStatus?.planType ? 'ChatGPTプラン: ' + codexStatus.planType : '専用profileのChatGPTサインインを確認します。'}</small></div><div className="codex-connection-actions"><button type="button" className="button button-light" onClick={startCodexLogin} disabled={testing}>{testing ? '確認中…' : 'ChatGPTでサインイン'}</button><button type="button" className="button button-light" onClick={test} disabled={testing}>{testing ? '確認中…' : '接続状態を確認'}</button>{loginCode && <button type="button" className="text-button" onClick={cancelCodexLogin} disabled={testing}>サインインを中止</button>}</div></div>
          {loginCode && <div className="codex-login-code"><div><span>公式デバイス認証URL（自分で開いてください）</span><code>{loginCode.verificationUrl}</code></div><div><span>一時コード</span><code>{loginCode.userCode}</code></div><small>アプリはブラウザーを開きません。コードを入力した後、この画面の「接続状態を確認」を押してください。</small></div>}
          {codexUsage && <div className="codex-usage"><strong>Codex利用枠</strong><span>現在のウィンドウ使用量 {codexUsage.usedPercent}%</span>{codexUsage.resetsAt && <small>リセット予定: {new Intl.DateTimeFormat('ja-JP', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(codexUsage.resetsAt * 1000))}</small>}</div>}
          <div className="privacy-callout codex-callout"><span>◈</span><div><strong>PlusのCodex枠を使う実験的な接続</strong><p>Platform APIキー・API従量課金へ切り替えません。アプリ専用profileに公式ChatGPT managed sign-inを行い、そのCodex利用枠を使います。通常のCodex profileにある認証ファイルやMCP設定は引き継ぎません。</p><p>解析時はシナリオ概要・全テキスト・画像・PDF抽出全文と全ページ画像に加え、役情報の送信設定で許可された有効方針・仮説・行動履歴（完了・見送り・更新、任意メモ）をCodexへ送ります。プロフィールと過去の整理結果の送信範囲は下の設定に従います。PDF画像は解析後に一時ファイルを削除し、原本はローカルに残します。</p><p>shell、apps、remote plugins、multi-agent、web searchを設定で無効化し、read-only sandboxとネットワーク無効を指定します。未対応のツール/権限要求は受け入れません。ただしread-only sandboxに読み取り対象を個別指定する仕組みはなく、App Serverも内部機能すべてを無効にできる保証はありません。空の作業フォルダーだけにアクセスを限定できるとは言えないため、実験的な接続の制約を理解してから使ってください。</p></div></div>
          <div className="pricing-note"><strong>アプリ側の解析上限とモデル選択</strong><p>資料は切り捨てず、1解析の添付合計40MiB・入力全文字数30万字・PDF合計200ページ・生成画像40MiBを超えると停止します。これはCodexの公称上限ではなく、このアプリの安全上限です。利用できるモデルと画像対応はCodexの一覧を取得して表示し、自動で別モデルへ切り替えません。</p></div>
          <label className="checkbox-row consent-row"><input type="checkbox" checked={draft.codexConsent} onChange={(event) => set('codexConsent', event.target.checked)}/><span><strong>Codexへ資料を送ることを理解しました。</strong><small>同意すると手動解析が有効になります。自動更新をONにした場合は、資料変更後に追加確認なしで同じ範囲を送ります。</small></span></label>
        </div>}
      </section>
      <section className="panel settings-panel automation-panel"><div className="panel-top"><div><span className="panel-kicker">02 / WHEN TO ANALYZE</span><h2>資料追加後の自動更新</h2></div><label className="toggle"><input type="checkbox" checked={draft.autoUpdate} onChange={(event) => set('autoUpdate', event.target.checked)} disabled={draft.provider === 'none' || (draft.provider === 'openai' && !draft.cloudConsent) || (draft.provider === 'ollama' && !draft.ollamaModel) || (draft.provider === 'codex' && !draft.codexConsent)}/><span className="toggle-track"/><b>{draft.autoUpdate ? 'ON' : 'OFF'}</b></label></div>
        <p className="panel-subcopy">ONにすると、シナリオ概要・新しい資料・公開範囲を保存した情報をまとめ、解析対象の全資料と最新の方針履歴から状況と方針を更新します。解析中も保存でき、追加分は次の更新へまとめます。追加ごとの確認ダイアログは表示しません。OFFなら「状況を更新」を押した時だけ解析します。</p>
        <label className="checkbox-row role-consent"><input type="checkbox" checked={draft.includeRoleProfile} onChange={(event) => set('includeRoleProfile', event.target.checked)}/><span><strong>自分の役・目的・秘密を解析に含める</strong><small>ONでは保存された役プロフィールをAIへ渡します。OFFではプロフィールに加え、役情報を使った解析由来・由来不明の過去の方針・仮説・履歴等も送信しません。以前の内容はこのPCの履歴で閲覧できます。同じ役情報がHOに含まれる場合は、HOを含む資料の送信設定に従います。</small></span></label>
        <div className="limit-row"><span>1解析の上限</span><strong>全添付40MiB ・ 抽出テキスト30万文字</strong><small>超える場合は、資料を捨てたり切り詰めたりせず解析を停止します。{draft.provider === 'codex' ? 'CodexではPDF画像200ページ・生成画像40MiBも上限です。' : ''}</small></div>
      </section>
      <div className="settings-save-row"><div>{testResult && <p className="test-result">{testResult}</p>}</div><div><button type="button" className="button button-light" onClick={test} disabled={testing || draft.provider === 'none'}>{testing ? '確認中…' : '接続をテスト'}</button><button type="submit" className="button button-ink" disabled={saving}>{saving ? '保存中…' : '設定を保存'}</button></div></div>
    </form>
    <section className="panel local-storage-panel"><div className="panel-top"><div><span className="panel-kicker">LOCAL DATA</span><h2>このPCの保存場所</h2></div><span className="lock-icon">◈</span></div><p>シナリオごとにフォルダーを分け、添付資料とJSONデータを保持します。削除は対象名を表示した確認ダイアログのあとに行います。バックアップはシナリオ画面からフォルダー単位で書き出せます。</p><div className="storage-path">{settings.dataFolder || 'アプリのデータフォルダー'}</div><button className="text-button" type="button" onClick={onDataFolder}>保存フォルダーを開く ↗</button>{scenario && <button type="button" className="text-button danger-link settings-delete" onClick={onDelete}>「{scenario.title}」を削除…</button>}</section>
    <p className="openai-footnote">OpenAI APIを使う場合はAPIキーをこのPCに登録してください。ChatGPT/Codexの契約とは別にAPI利用料が発生する場合があります。</p>
  </div>;
}

export default App;
