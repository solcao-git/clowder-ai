'use client';

import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { CatData } from '@/hooks/useCatData';
import { apiFetch } from '@/utils/api-client';
import type { ConfigData } from './config-viewer-types';
import type { TemplateCard } from './first-run-quest/TemplateStep';
import type { AccountsResponse, ProfileItem } from './hub-accounts.types';
import { uploadAvatarAsset, uploadRefAudioAsset } from './hub-cat-editor.client';
import {
  autoSlug,
  buildCatPatchPayload,
  buildCatPayload,
  buildCodexConfigPatches,
  buildStrategyPayload,
  builtinAccountIdForClient,
  type CodexRuntimeSettings,
  DEFAULT_ANTIGRAVITY_COMMAND_ARGS,
  filterAccounts,
  type HubCatEditorDraft,
  type HubCatEditorFormState,
  initialState,
  joinTags,
  normalizeMentionPattern,
  type StrategyFormState,
  splitMentionPatterns,
  toCodexRuntimeSettings,
  toStrategyForm,
  withDefaultModelMentionPattern,
} from './hub-cat-editor.model';
import { AccountSection, IdentitySection, RoutingSection } from './hub-cat-editor.sections';
import { AdvancedRuntimeSection } from './hub-cat-editor-advanced';
import { PersistenceBanner } from './hub-cat-editor-fields';
import type { CatStrategyEntry } from './hub-strategy-types';
import { useConfirm } from './useConfirm';

interface HubCatEditorProps {
  cat?: CatData | null;
  draft?: HubCatEditorDraft | null;
  /** All cats — used for alias uniqueness validation. */
  existingCats?: CatData[];
  /** F208 OQ-9: true when this cat has a structured dossier profile. */
  hasDossier?: boolean;
  open: boolean;
  onClose: () => void;
  onSaved: () => Promise<void> | void;
}

export function HubCatEditor({ cat, draft, existingCats, hasDossier, open, onClose, onSaved }: HubCatEditorProps) {
  const confirm = useConfirm();
  const [profiles, setProfiles] = useState<ProfileItem[]>([]);
  const [loadingProfiles, setLoadingProfiles] = useState(false);
  const [loadingStrategy, setLoadingStrategy] = useState(false);
  const [loadingCodexSettings, setLoadingCodexSettings] = useState(false);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [strategyError, setStrategyError] = useState<string | null>(null);
  const [codexSettingsError, setCodexSettingsError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, boolean>>({});
  const [form, setForm] = useState<HubCatEditorFormState>(() => initialState(cat, draft));
  const [strategyForm, setStrategyForm] = useState<StrategyFormState | null>(null);
  const [strategyBaseline, setStrategyBaseline] = useState<StrategyFormState | null>(null);
  const [strategyBaselineHasOverride, setStrategyBaselineHasOverride] = useState(false);
  const [codexSettings, setCodexSettings] = useState<CodexRuntimeSettings | null>(null);
  const [codexSettingsBaseline, setCodexSettingsBaseline] = useState<CodexRuntimeSettings | null>(null);
  const [templates, setTemplates] = useState<TemplateCard[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>('custom');

  const availableProfiles = useMemo(() => filterAccounts(form.clientId, profiles), [form.clientId, profiles]);
  const selectedProfile = useMemo(
    () => availableProfiles.find((profile) => profile.id === form.accountRef) ?? null,
    [availableProfiles, form.accountRef],
  );

  // 按 family（国家）分组 templates，未填 family 的归到"其他"
  const groupedByFamily = useMemo(() => {
    const order: { family: string; familyDisplayName: string; color: string }[] = [];
    const map = new Map<string, TemplateCard[]>();
    for (const t of templates) {
      const key = t.family ?? '__other__';
      if (!map.has(key)) {
        map.set(key, []);
        order.push({
          family: key,
          familyDisplayName: t.familyDisplayName ?? '其他',
          color: t.color?.primary ?? '#888',
        });
      }
      map.get(key)!.push(t);
    }
    return order.map((g) => ({
      ...g,
      members: map.get(g.family) ?? [],
    }));
  }, [templates]);

  // 布局分流：多角色国家（≥2 只）走 grid-cols-2 独立卡片，单角色国家（=1 只）合并成密集行
  const multiFamilyGroups = useMemo(
    () => groupedByFamily.filter((g) => g.members.length >= 2),
    [groupedByFamily],
  );
  const singleFamilyGroups = useMemo(
    () => groupedByFamily.filter((g) => g.members.length === 1),
    [groupedByFamily],
  );
  const modelOptions = useMemo(() => {
    if (form.clientId === 'antigravity') return [];
    return selectedProfile?.models ?? [];
  }, [form.clientId, selectedProfile]);
  const showCodexSettings = form.clientId === 'openai';
  const codexSettingsEditable = !showCodexSettings || codexSettingsBaseline !== null;

  // Alias uniqueness: collect all patterns from OTHER cats (lowercase for comparison)
  const reservedPatterns = useMemo(() => {
    if (!existingCats?.length) return new Set<string>();
    const editingId = cat?.id;
    const set = new Set<string>();
    for (const c of existingCats) {
      if (c.id === editingId) continue;
      for (const p of c.mentionPatterns) set.add(p.toLowerCase());
    }
    return set;
  }, [existingCats, cat?.id]);

  useEffect(() => {
    if (!open) return;
    setForm(initialState(cat, draft));
    setFieldErrors({});
    setError(null);
    setStrategyError(null);
    setCodexSettingsError(null);
    setStrategyBaselineHasOverride(false);
    setCodexSettingsBaseline(null);
    setSelectedTemplateId('custom');
    setHasUnsavedChanges(false);
  }, [open, cat, draft]);

  // Re-fetch profiles when Provider Profiles page creates/saves/deletes an account.
  const [profilesVersion, setProfilesVersion] = useState(0);
  useEffect(() => {
    const handler = () => setProfilesVersion((v) => v + 1);
    window.addEventListener('accounts-changed', handler);
    return () => window.removeEventListener('accounts-changed', handler);
  }, []);

  useEffect(() => {
    if (!open || cat) {
      setTemplates([]);
      return;
    }
    let cancelled = false;
    apiFetch('/api/cat-templates')
      .then(async (res) => {
        if (!res.ok) throw new Error('load failed');
        return (await res.json()) as { templates?: TemplateCard[] };
      })
      .then((body) => {
        if (!cancelled) setTemplates(body.templates ?? []);
      })
      .catch(() => {
        if (!cancelled) setTemplates([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open, cat]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoadingProfiles(true);
    apiFetch('/api/accounts')
      .then(async (res) => {
        if (!res.ok) throw new Error(`账号配置加载失败 (${res.status})`);
        return (await res.json()) as AccountsResponse;
      })
      .then((body) => {
        if (!cancelled) setProfiles(body.providers);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : '账号配置加载失败');
      })
      .finally(() => {
        if (!cancelled) setLoadingProfiles(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, profilesVersion]);

  useEffect(() => {
    if (!open || !cat) {
      setStrategyForm(null);
      setStrategyBaseline(null);
      setStrategyBaselineHasOverride(false);
      setLoadingStrategy(false);
      return;
    }
    let cancelled = false;
    setStrategyForm(null);
    setStrategyBaseline(null);
    setLoadingStrategy(true);
    apiFetch('/api/config/session-strategy')
      .then(async (res) => {
        if (!res.ok) throw new Error(`Session 策略加载失败 (${res.status})`);
        return (await res.json()) as { cats?: CatStrategyEntry[] };
      })
      .then((body) => {
        if (cancelled) return;
        const entry = body.cats?.find((item) => item.catId === cat.id) ?? null;
        const nextStrategyForm = entry ? toStrategyForm(entry) : null;
        setStrategyForm(nextStrategyForm);
        setStrategyBaseline(nextStrategyForm);
        setStrategyBaselineHasOverride(Boolean(entry?.hasOverride));
      })
      .catch((err) => {
        if (!cancelled) setStrategyError(err instanceof Error ? err.message : 'Session 策略加载失败');
      })
      .finally(() => {
        if (!cancelled) setLoadingStrategy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, cat]);

  useEffect(() => {
    if (!open || !showCodexSettings) {
      setCodexSettings(null);
      setCodexSettingsBaseline(null);
      setLoadingCodexSettings(false);
      return;
    }
    let cancelled = false;
    setLoadingCodexSettings(true);
    Promise.resolve()
      .then(() => apiFetch('/api/config'))
      .then(async (res) => {
        if (!res.ok) throw new Error(`Codex 运行参数加载失败 (${res.status})`);
        return (await res.json()) as { config?: ConfigData };
      })
      .then((body) => {
        if (cancelled) return;
        const next = toCodexRuntimeSettings(body.config);
        setCodexSettings(next);
        setCodexSettingsBaseline(next);
      })
      .catch((err) => {
        if (!cancelled) {
          const fallback = toCodexRuntimeSettings();
          setCodexSettings((prev) => prev ?? fallback);
          setCodexSettingsError(err instanceof Error ? err.message : 'Codex 运行参数加载失败');
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingCodexSettings(false);
      });
    return () => {
      cancelled = true;
    };
  }, [cat, open, showCodexSettings]);

  useEffect(() => {
    if (form.clientId === 'antigravity') {
      setForm((prev) => (prev.accountRef === '' ? prev : { ...prev, accountRef: '' }));
      return;
    }
    setForm((prev) => {
      if (prev.accountRef.trim().length === 0 && (cat || !draft)) {
        return prev;
      }
      if (availableProfiles.length === 0) return prev;
      const preferredBuiltin = builtinAccountIdForClient(prev.clientId);
      const nextProfile =
        availableProfiles.find((profile) => profile.id === prev.accountRef) ??
        (preferredBuiltin ? availableProfiles.find((profile) => profile.id === preferredBuiltin) : null) ??
        availableProfiles[0] ??
        null;
      if (!nextProfile) return prev;
      if (prev.accountRef === nextProfile.id) return prev;
      return { ...prev, accountRef: nextProfile.id };
    });
  }, [availableProfiles, cat, draft, form.clientId]);

  // Auto-fill first available model only on profile/client change — NOT when
  // the user clears the field. Previous code had form.defaultModel in deps,
  // which re-filled immediately after the user cleared the input (#802).
  useEffect(() => {
    if (form.clientId === 'antigravity' || modelOptions.length === 0) return;
    setForm((prev) => {
      if (prev.clientId === 'antigravity' || prev.defaultModel.trim().length > 0) return prev;
      return { ...prev, defaultModel: modelOptions[0] ?? '' };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally
    // excludes form.defaultModel: auto-fill runs on profile change, not on
    // user clearing the model input.
  }, [form.clientId, modelOptions]);

  useEffect(() => {
    if (form.clientId !== 'antigravity') return;
    if (form.commandArgs.trim().length > 0) return;
    setForm((prev) => {
      if (prev.clientId !== 'antigravity') return prev;
      if (prev.commandArgs.trim().length > 0) return prev;
      return { ...prev, commandArgs: DEFAULT_ANTIGRAVITY_COMMAND_ARGS };
    });
  }, [form.clientId, form.commandArgs]);

  if (!open) return null;

  const saveBlockedByProfileBinding = false;

  const patchForm = (patch: Partial<HubCatEditorFormState>) => {
    setHasUnsavedChanges(true);
    setForm((prev) => ({ ...prev, ...patch }));
    if (patch.mentionPatterns !== undefined) {
      setFieldErrors((prev) => ({ ...prev, routing: false }));
    }
    if (patch.name !== undefined || patch.roleDescription !== undefined) {
      setFieldErrors((prev) => ({ ...prev, identity: false }));
    }
    if (patch.defaultModel !== undefined || patch.clientId !== undefined) {
      setFieldErrors((prev) => ({ ...prev, account: false }));
    }
  };
  const patchStrategy = (patch: Partial<StrategyFormState>) => {
    setHasUnsavedChanges(true);
    setStrategyForm((prev) => (prev ? { ...prev, ...patch } : prev));
  };
  const patchCodex = (patch: Partial<CodexRuntimeSettings>) => {
    setHasUnsavedChanges(true);
    setCodexSettings((prev) => ({
      ...(prev ?? toCodexRuntimeSettings()),
      ...patch,
    }));
  };

  const handleTemplateSelect = (t: TemplateCard | null) => {
    if (!t) {
      setSelectedTemplateId('custom');
      setForm(initialState(null, null));
      setHasUnsavedChanges(false);
      return;
    }
    setSelectedTemplateId(t.id);
    // 优先用 nickname（角色名，如"提纳里"），fallback 到 name（猫种名）
    const displayName = t.nickname ?? t.name;
    const name = displayName;
    const catId = autoSlug(name);
    // Auto-suffix aliases that conflict with existing cats
    const rawAliases = [displayName, t.name].filter((s): s is string => Boolean(s) && s !== displayName);
    const deduped = rawAliases.map((alias) => {
      const normalized = normalizeMentionPattern(alias);
      if (!reservedPatterns.has(normalized.toLowerCase())) return normalized;
      for (let i = 2; i <= 99; i++) {
        const candidate = normalizeMentionPattern(`${alias}${i}`);
        if (!reservedPatterns.has(candidate.toLowerCase())) return candidate;
      }
      return normalized; // fallback — backend will catch it
    });
    patchForm({
      name,
      displayName: name,
      nickname: t.nickname ?? '',
      avatar: t.avatar ?? '',
      colorPrimary: t.color.primary,
      colorSecondary: t.color.secondary,
      roleDescription: t.roleDescription,
      personality: t.personality,
      teamStrengths: t.teamStrengths ?? '',
      catId,
      mentionPatterns: joinTags(deduped),
    });
  };

  const requestClose = async () => {
    if (!hasUnsavedChanges) {
      onClose();
      return;
    }
    if (await confirm({ title: '关闭确认', message: '有未保存的修改，确定要关闭吗？' })) onClose();
  };

  const handleAvatarUpload = async (file: File) => {
    setUploadingAvatar(true);
    setError(null);
    try {
      patchForm({ avatar: await uploadAvatarAsset(file) });
    } catch (err) {
      setError(err instanceof Error ? err.message : '头像上传失败');
    } finally {
      setUploadingAvatar(false);
    }
  };

  const handleRefAudioUpload = async (file: File) => {
    setError(null);
    await uploadRefAudioAsset(file).then(
      (result) => patchForm({ voiceRefAudio: result.url }),
      (err) => setError(err instanceof Error ? err.message : '参考音频上传失败'),
    );
  };

  const handleSave = async () => {
    const errors: Record<string, boolean> = {};
    const errorMessages: string[] = [];
    // Create-only pre-flight: existing cats already passed backend validation.
    if (!cat) {
      if (!form.name.trim()) {
        errors.identity = true;
        errorMessages.push('名称');
      }
      if (!form.roleDescription.trim()) {
        errors.identity = true;
        errorMessages.push('角色描述');
      }
      if (!form.defaultModel.trim() && selectedProfile?.authType === 'api_key') {
        errors.account = true;
        errorMessages.push('Model');
      } else if (
        form.clientId === 'opencode' &&
        selectedProfile?.authType === 'api_key' &&
        !form.provider.trim() &&
        (() => {
          const m = form.defaultModel.trim();
          const si = m.indexOf('/');
          const looksLike = si > 0 && si < m.length - 1;
          if (!looksLike) return true; // bare model, need provider
          // Known provider prefix → canonical (synced with BUILTIN_OPENCODE_PROVIDERS)
          const known = new Set(['anthropic', 'openai', 'openrouter', 'google']);
          if (known.has(m.slice(0, si))) return false;
          // Non-builtin: "x/y" in account list + bare "y" absent → namespace
          const acm = selectedProfile?.models ?? [];
          const bare = m.slice(si + 1);
          return acm.includes(m) && !acm.includes(bare);
        })()
      ) {
        errors.account = true;
        errorMessages.push('请使用 provider/model 格式（如 minimax/MiniMax-M2.7），或填写 Provider 名称');
      }
      const effectiveCreateForm = selectedProfile?.authType === 'api_key' ? withDefaultModelMentionPattern(form) : form;
      if (splitMentionPatterns(effectiveCreateForm.mentionPatterns).length === 0) {
        errors.routing = true;
        errorMessages.push('别名');
      }
    }
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      setError(`请填写必填字段：${errorMessages.join('、')}`);
      return;
    }
    setFieldErrors({});
    setSaving(true);
    setError(null);
    const rollbackSteps: Array<() => Promise<void>> = [];
    const rollbackMutations = async () => {
      for (const rollback of rollbackSteps.reverse()) {
        await rollback().catch(() => {});
      }
    };
    try {
      const effectiveForm =
        !cat && selectedProfile?.authType === 'api_key' ? withDefaultModelMentionPattern(form) : form;
      const catPayload = cat ? buildCatPatchPayload(effectiveForm, cat) : buildCatPayload(effectiveForm, cat);
      const rollbackCatPayload = cat ? buildCatPayload(initialState(cat, null), cat) : null;
      const strategyEditable = Boolean(
        cat && form.sessionChain === 'true' && (strategyForm?.sessionChainEnabled ?? true),
      );
      const nextStrategyPayload = strategyEditable && strategyForm ? buildStrategyPayload(strategyForm) : null;
      const baselineStrategyPayload =
        strategyEditable && strategyBaseline ? buildStrategyPayload(strategyBaseline) : null;
      const strategyChanged =
        cat && nextStrategyPayload && strategyEditable
          ? JSON.stringify(nextStrategyPayload) !== JSON.stringify(baselineStrategyPayload)
          : false;

      if (cat && strategyChanged && nextStrategyPayload) {
        const strategyRes = await apiFetch(`/api/config/session-strategy/${cat.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(nextStrategyPayload),
        });
        if (!strategyRes.ok) {
          const payload = (await strategyRes.json().catch(() => ({}))) as Record<string, unknown>;
          setError((payload.error as string) ?? `Session 策略保存失败 (${strategyRes.status})`);
          return;
        }
        if (strategyBaselineHasOverride && baselineStrategyPayload) {
          rollbackSteps.push(async () => {
            await apiFetch(`/api/config/session-strategy/${cat.id}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(baselineStrategyPayload),
            });
          });
        } else {
          rollbackSteps.push(async () => {
            await apiFetch(`/api/config/session-strategy/${cat.id}`, {
              method: 'DELETE',
            });
          });
        }
      }

      const res = await apiFetch(cat ? `/api/cats/${cat.id}` : '/api/cats', {
        method: cat ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(catPayload),
      });
      if (!res.ok) {
        await rollbackMutations();
        const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        setError((payload.error as string) ?? `保存失败 (${res.status})`);
        return;
      }
      const persistedCatBody = (await res.json().catch(() => ({}))) as { cat?: { id?: string } };
      const persistedCatId = persistedCatBody.cat?.id ?? cat?.id ?? null;
      if (persistedCatId) {
        if (cat && rollbackCatPayload) {
          rollbackSteps.push(async () => {
            await apiFetch(`/api/cats/${persistedCatId}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(rollbackCatPayload),
            });
          });
        } else if (!cat) {
          rollbackSteps.push(async () => {
            await apiFetch(`/api/cats/${persistedCatId}`, {
              method: 'DELETE',
            });
          });
        }
      }

      if (showCodexSettings && codexSettings && codexSettingsBaseline) {
        const codexPatches = buildCodexConfigPatches(codexSettings, codexSettingsBaseline);
        const rollbackCodexPatches = buildCodexConfigPatches(codexSettingsBaseline, codexSettings);
        const appliedConfigPatchKeys: string[] = [];
        for (const patch of codexPatches) {
          const configRes = await apiFetch('/api/config', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(patch),
          });
          if (!configRes.ok) {
            const appliedRollbackPatches = rollbackCodexPatches.filter((rollbackPatch) =>
              appliedConfigPatchKeys.includes(rollbackPatch.key),
            );
            for (const rollbackPatch of appliedRollbackPatches.reverse()) {
              await apiFetch('/api/config', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(rollbackPatch),
              }).catch(() => {});
            }
            await rollbackMutations();
            const payload = (await configRes.json().catch(() => ({}))) as Record<string, unknown>;
            setError((payload.error as string) ?? `Codex 运行参数保存失败 (${configRes.status})`);
            return;
          }
          appliedConfigPatchKeys.push(patch.key);
        }
      }

      await onSaved();
      window.dispatchEvent(new CustomEvent('guide:confirm', { detail: { target: 'member-editor.profile' } }));
      onClose();
    } catch (err) {
      await rollbackMutations();
      setError(err instanceof Error ? err.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-[var(--console-overlay-medium)] px-4 backdrop-blur-sm"
      onClick={requestClose}
      data-bootcamp-host="cat-editor-modal"
    >
      <div
        className="member-editor-modal flex max-h-[88vh] w-full max-w-[720px] flex-col overflow-hidden rounded-[28px] bg-[var(--console-card-bg)] shadow-[0_22px_48px_rgba(43,33,26,0.13)]"
        role="dialog"
        aria-modal="true"
        aria-labelledby="member-editor-title"
        data-guide-id="member-editor.profile"
        onClick={(event) => event.stopPropagation()}
        data-bootcamp-step="cat-editor"
      >
        <div className="flex shrink-0 items-start justify-between px-7 py-5">
          <p id="member-editor-title" className="text-compact font-extrabold text-[var(--console-modal-title)]">
            {cat ? cat.displayName || cat.name || cat.id : '添加成员'}
          </p>
          <button
            type="button"
            onClick={requestClose}
            className="flex h-8 w-8 items-center justify-center rounded-[10px] bg-[var(--console-modal-close-bg)] text-lg font-extrabold leading-none text-[var(--console-modal-close-fg)] transition hover:opacity-80"
            aria-label="关闭"
          >
            ×
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-7 py-5">
          {!cat && templates.length > 0 && (
            <section
              data-guide-id="add-member.template-picker"
              className="space-y-4 rounded-[18px] bg-[var(--console-card-bg)] p-[18px] shadow-[0_8px_22px_rgba(43,33,26,0.04)]"
            >
              <div>
                <h4 className="text-base font-extrabold text-cafe">成员模板</h4>
                <p className="mt-1 text-xs font-semibold text-cafe-secondary">
                  从内置成员模板开始，选择后自动填充身份、模型与运行时默认值。
                </p>
              </div>

              {/* 顶部一行：自定义按钮 + "或选择模板" 提示 */}
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => handleTemplateSelect(null)}
                  data-template-id="custom"
                  className={`flex shrink-0 items-center gap-2 rounded-xl border-2 border-dashed px-3 py-2 text-left transition ${
                    selectedTemplateId === 'custom'
                      ? 'border-[var(--cafe-accent)] bg-[var(--cafe-accent)]/10 text-[var(--cafe-accent)]'
                      : 'border-[var(--console-border-soft)] text-[var(--console-template-text)] hover:border-[var(--cafe-accent)]/50'
                  }`}
                >
                  <span className="flex h-6 w-6 items-center justify-center rounded-full bg-[var(--console-field-bg)] text-sm">
                    ✎
                  </span>
                  <span className="text-compact font-extrabold">自定义</span>
                </button>
                <div className="flex flex-1 items-center gap-2 text-[10px] font-extrabold uppercase tracking-wider text-cafe-muted">
                  <span className="h-px flex-1 bg-[var(--console-border-soft)]" />
                  <span>或选择角色模板</span>
                  <span className="h-px flex-1 bg-[var(--console-border-soft)]" />
                </div>
              </div>

              {/* 多角色国家（≥2 只）：双列网格，每国独立卡片 */}
              {multiFamilyGroups.length > 0 && (
                <div className="grid grid-cols-2 gap-2">
                  {multiFamilyGroups.map((group) => (
                    <div
                      key={group.family}
                      className="rounded-xl border border-[var(--console-border-soft)] bg-[var(--console-field-bg)]/40 p-2"
                    >
                      <div className="mb-1.5 flex items-center gap-1.5 px-0.5 text-[10px] font-extrabold uppercase tracking-wider text-cafe-muted">
                        <span
                          className="h-1.5 w-1.5 rounded-full"
                          style={{ backgroundColor: group.color }}
                          aria-hidden
                        />
                        <span>{group.familyDisplayName}</span>
                        <span className="text-cafe-muted/60">·</span>
                        <span className="text-cafe-muted/60">{group.members.length} 只</span>
                      </div>
                      <div className="flex flex-col gap-1">
                        {group.members.map((t) => (
                          <TemplateChip
                            key={t.id}
                            template={t}
                            isSelected={selectedTemplateId === t.id}
                            onSelect={(tmpl) =>
                              handleTemplateSelect(
                                selectedTemplateId === tmpl.id ? null : tmpl,
                              )
                            }
                          />
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* 单角色国家（=1 只）：合并成密集一行，chip 内嵌国家名前缀 */}
              {singleFamilyGroups.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {singleFamilyGroups.flatMap((group) =>
                    group.members.map((t) => (
                      <TemplateChip
                        key={t.id}
                        template={t}
                        isSelected={selectedTemplateId === t.id}
                        prefix={group.familyDisplayName}
                        onSelect={(tmpl) =>
                          handleTemplateSelect(
                            selectedTemplateId === tmpl.id ? null : tmpl,
                          )
                        }
                      />
                    )),
                  )}
                </div>
              )}
            </section>
          )}
          <IdentitySection
            cat={cat}
            form={form}
            hasError={fieldErrors.identity}
            avatarUploading={uploadingAvatar}
            hasDossier={hasDossier}
            onChange={patchForm}
            onAvatarUpload={handleAvatarUpload}
            onRefAudioUpload={handleRefAudioUpload}
          />
          <AccountSection
            form={form}
            hasError={fieldErrors.account}
            modelOptions={modelOptions}
            availableProfiles={availableProfiles}
            loadingProfiles={loadingProfiles}
            onChange={patchForm}
          />
          <RoutingSection
            form={form}
            hasError={fieldErrors.routing}
            reservedPatterns={reservedPatterns}
            onChange={patchForm}
          />
          <AdvancedRuntimeSection
            cat={cat}
            form={form}
            strategyForm={strategyForm}
            loadingStrategy={loadingStrategy}
            strategyError={strategyError}
            codexSettings={codexSettings}
            loadingCodexSettings={loadingCodexSettings}
            codexSettingsError={codexSettingsError}
            codexSettingsEditable={codexSettingsEditable}
            showCodexSettings={showCodexSettings}
            onChange={patchForm}
            onStrategyChange={patchStrategy}
            onCodexChange={patchCodex}
          />
          <PersistenceBanner />
          {error ? <p className="rounded-2xl bg-conn-red-bg px-4 py-3 text-sm text-conn-red-text">{error}</p> : null}
        </div>

        <div className="flex items-center justify-end px-7 pb-5 pt-4">
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || saveBlockedByProfileBinding}
            className="h-8 rounded-[10px] bg-[var(--cafe-accent)] px-4 text-compact font-extrabold text-[var(--cafe-surface)] transition hover:bg-[var(--cafe-accent-hover)] disabled:opacity-50"
          >
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// 单个角色 chip — 多角色国家卡片 / 单角色国家密集行 共用
function TemplateChip({
  template,
  isSelected,
  prefix,
  onSelect,
}: {
  template: TemplateCard;
  isSelected: boolean;
  prefix?: string;
  onSelect: (t: TemplateCard) => void;
}) {
  const borderColor = isSelected ? undefined : `${template.color.primary}40`;
  return (
    <button
      type="button"
      onClick={() => onSelect(template)}
      data-template-id={template.id}
      className={`flex items-center gap-2 rounded-xl border-2 px-2.5 py-1.5 transition ${
        isSelected
          ? 'border-[var(--cafe-accent)] bg-[var(--cafe-accent)]/10 shadow-sm'
          : 'border-transparent bg-[var(--console-field-bg)] hover:border-[var(--cafe-accent)]/40'
      }`}
      style={borderColor ? { borderColor } : undefined}
    >
      <span
        className="flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded-full text-[10px] font-extrabold"
        style={{
          backgroundColor: template.color.secondary,
          color: template.color.primary,
        }}
      >
        {template.nickname?.charAt(0) ?? template.name.charAt(0)}
      </span>
      <span
        className={`text-compact font-extrabold ${
          isSelected
            ? 'text-[var(--cafe-accent)]'
            : 'text-[var(--console-template-text)]'
        }`}
      >
        {prefix && (
          <span className="mr-1 text-[10px] font-semibold uppercase tracking-wide opacity-60">
            {prefix}·
          </span>
        )}
        {template.nickname ?? template.name}
      </span>
    </button>
  );
}
