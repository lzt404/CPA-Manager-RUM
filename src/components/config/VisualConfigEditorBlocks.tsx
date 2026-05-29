import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Select } from '@/components/ui/Select';
import {
  buildUsageServiceBaseCandidates,
  isUsageServiceId,
  usageServiceApi,
  type ApiKeyAlias,
} from '@/services/api/usageService';
import { authFilesApi } from '@/services/api/authFiles';
import { providersApi } from '@/services/api/providers';
import { useAuthStore, useConfigStore, useNotificationStore, useUsageServiceStore } from '@/stores';
import styles from './VisualConfigEditor.module.scss';
import { copyToClipboard } from '@/utils/clipboard';
import { detectApiBaseFromLocation } from '@/utils/connection';
import { normalizeAuthIndex } from '@/utils/authIndex';
import type { AuthFileItem } from '@/types/authFile';
import type { Config } from '@/types/config';
import type {
  ApiKeyAccessRule,
  PayloadFilterRule,
  PayloadHeaderEntry,
  PayloadModelEntry,
  PayloadParamEntry,
  PayloadParamValidationErrorCode,
  PayloadParamValueType,
  PayloadRule,
} from '@/types/visualConfig';
import { makeClientId } from '@/types/visualConfig';
import {
  getPayloadParamValidationError,
  VISUAL_CONFIG_PAYLOAD_VALUE_TYPE_OPTIONS,
  VISUAL_CONFIG_PROTOCOL_OPTIONS,
} from '@/hooks/useVisualConfig';
import { maskApiKey } from '@/utils/format';
import { sha256Hex } from '@/utils/apiKeyHash';
import { isValidApiKeyCharset } from '@/utils/validation';

/** Minimum character count before the expand/collapse toggle appears. */
const EXPAND_THRESHOLD = 30;

type AuthIndexOption = {
  value: string;
  label: string;
  searchText: string;
};

type AuthIndexSourceConfig = Partial<
  Pick<
    Config,
    'geminiApiKeys' | 'codexApiKeys' | 'claudeApiKeys' | 'vertexApiKeys' | 'openaiCompatibility'
  >
>;

function readAuthOptionText(value: unknown): string {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function readAuthOptionRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readAuthOptionField(value: unknown, key: string): unknown {
  return readAuthOptionRecord(value)?.[key];
}

function firstAuthOptionText(...values: unknown[]): string {
  for (const value of values) {
    const text = readAuthOptionText(value);
    if (text) return text;
  }
  return '';
}

function readAuthOptionBaseName(value: unknown): string {
  const text = readAuthOptionText(value);
  if (!text) return '';
  const parts = text.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] || text;
}

function appendAuthOptionPart(parts: string[], value: unknown) {
  const text = readAuthOptionText(value);
  if (!text) return;
  const key = text.toLowerCase();
  if (parts.some((part) => part.toLowerCase() === key)) return;
  parts.push(text);
}

function compactAuthOptionText(value: string, maxLength = 38): string {
  const text = value.trim();
  if (text.length <= maxLength) return text;
  if (text.includes('@')) {
    const [name, domain] = text.split('@');
    if (name && domain) {
      const compactName = name.length > 14 ? `${name.slice(0, 6)}...${name.slice(-4)}` : name;
      const compactDomain =
        domain.length > 18 ? `${domain.slice(0, 8)}...${domain.slice(-7)}` : domain;
      return `${compactName}@${compactDomain}`;
    }
  }
  return `${text.slice(0, 18)}...${text.slice(-10)}`;
}

function buildReadableAuthIndexOption(
  authIndex: string,
  labelParts: Array<unknown>,
  label?: string
): AuthIndexOption {
  const parts: string[] = [];
  labelParts.forEach((part) => appendAuthOptionPart(parts, part));
  const detail = parts.length > 0 ? parts.join(' / ') : 'Credential';
  const displayLabel = readAuthOptionText(label) || parts[0] || `#${authIndex}`;

  return {
    value: authIndex,
    label: compactAuthOptionText(displayLabel, 42),
    searchText: `${displayLabel} ${detail} ${authIndex}`,
  };
}

function buildAuthFileOptionLabel(file: AuthFileItem): string {
  return (
    readAuthOptionBaseName(file.name) ||
    readAuthOptionBaseName(file['filename']) ||
    readAuthOptionBaseName(file['path']) ||
    readAuthOptionText(file.provider ?? file.type) ||
    'OAuth'
  );
}

function buildAuthFileLabelParts(file: AuthFileItem): string[] {
  const idToken = file['id_token'];
  const profile = readAuthOptionRecord(file['profile']);
  const profileUser = readAuthOptionField(profile, 'user');
  const profileAccount = readAuthOptionField(profile, 'account');
  const account = firstAuthOptionText(
    file['account'],
    file['email'],
    readAuthOptionField(idToken, 'email'),
    readAuthOptionField(profileUser, 'email'),
    readAuthOptionField(profile, 'email'),
    file['client_email']
  );
  const accountID = firstAuthOptionText(
    file['account_id'],
    file['accountId'],
    file['chatgpt_account_id'],
    file['chatgptAccountId'],
    readAuthOptionField(idToken, 'account_id'),
    readAuthOptionField(idToken, 'accountId'),
    readAuthOptionField(idToken, 'chatgpt_account_id'),
    readAuthOptionField(idToken, 'chatgptAccountId'),
    readAuthOptionField(profileAccount, 'id'),
    readAuthOptionField(profileAccount, 'account_id'),
    readAuthOptionField(profileAccount, 'accountId'),
    readAuthOptionField(profileAccount, 'chatgpt_account_id'),
    readAuthOptionField(profileAccount, 'chatgptAccountId')
  );
  const projectID = firstAuthOptionText(
    file['project_id'],
    file['projectId'],
    file['gemini_virtual_project'],
    file['geminiVirtualProject']
  );
  const parts: string[] = [];
  appendAuthOptionPart(parts, file.provider ?? file.type ?? 'OAuth');
  appendAuthOptionPart(parts, account);
  appendAuthOptionPart(parts, accountID);
  appendAuthOptionPart(parts, projectID);
  appendAuthOptionPart(parts, file['label']);
  appendAuthOptionPart(parts, file.name);
  if (file.disabled) appendAuthOptionPart(parts, 'disabled');
  return parts;
}

/** Auto-expanding textarea that collapses back to a single-line input on demand. */
function ExpandableInput({
  value,
  placeholder,
  ariaLabel,
  disabled,
  className,
  onChange,
}: {
  value: string;
  placeholder?: string;
  ariaLabel?: string;
  disabled?: boolean;
  className?: string;
  onChange: (nextValue: string) => void;
}) {
  const { t } = useTranslation();
  const [collapsed, setCollapsed] = useState(true);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const autoResize = useCallback((el: HTMLTextAreaElement) => {
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, []);

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    // Strip newlines — these fields are single-line identifiers/paths that
    // would break YAML serialization if they contained line breaks.
    const sanitized = e.target.value.replace(/[\r\n]/g, '');
    onChange(sanitized);
    // autoResize is handled by useLayoutEffect after React syncs the
    // sanitized value back to the DOM — calling it here would measure
    // stale content.
  };

  // Resize synchronously before paint to avoid visual flicker.
  useLayoutEffect(() => {
    if (!collapsed && textareaRef.current) {
      autoResize(textareaRef.current);
    }
  }, [collapsed, value, autoResize]);

  if (collapsed) {
    return (
      <div className={styles.expandableInputWrapper}>
        <input
          className={`input ${className ?? ''}`}
          placeholder={placeholder}
          aria-label={ariaLabel}
          value={value}
          onChange={(e) => onChange(e.target.value.replace(/[\r\n]/g, ''))}
          disabled={disabled}
        />
        {value.length > EXPAND_THRESHOLD && (
          <button
            type="button"
            className={styles.expandableToggle}
            disabled={disabled}
            onClick={() => {
              setCollapsed(false);
              requestAnimationFrame(() => {
                textareaRef.current?.focus();
              });
            }}
            title={t('common.expand')}
            aria-label={t('common.expand')}
          >
            ▼
          </button>
        )}
      </div>
    );
  }

  return (
    <div className={`${styles.expandableInputWrapper} ${styles.expandableInputExpanded}`}>
      <textarea
        ref={textareaRef}
        className={`input ${styles.expandableTextarea} ${className ?? ''}`}
        placeholder={placeholder}
        aria-label={ariaLabel}
        value={value}
        onChange={handleChange}
        disabled={disabled}
        rows={2}
      />
      <button
        type="button"
        className={styles.expandableToggle}
        disabled={disabled}
        onClick={() => setCollapsed(true)}
        title={t('common.collapse')}
        aria-label={t('common.collapse')}
      >
        ▲
      </button>
    </div>
  );
}

function getValidationMessage(
  t: ReturnType<typeof useTranslation>['t'],
  errorCode?: PayloadParamValidationErrorCode
) {
  if (!errorCode) return undefined;
  return t(`config_management.visual.validation.${errorCode}`);
}

function buildProtocolOptions(
  t: ReturnType<typeof useTranslation>['t'],
  rules: Array<{ models: PayloadModelEntry[] }>
) {
  const options: Array<{ value: string; label: string }> = VISUAL_CONFIG_PROTOCOL_OPTIONS.map(
    (option) => ({
      value: option.value,
      label: t(option.labelKey, { defaultValue: option.defaultLabel }),
    })
  );
  const seen = new Set<string>(options.map((option) => option.value));

  for (const rule of rules) {
    for (const model of rule.models) {
      const protocol = model.protocol;
      if (!protocol || !protocol.trim() || seen.has(protocol)) continue;
      seen.add(protocol);
      options.push({ value: protocol, label: protocol });
    }
  }

  return options;
}

function addAuthIndexOption(
  optionsByValue: Map<string, AuthIndexOption>,
  value: unknown,
  labelParts: Array<unknown>,
  label?: string
) {
  const authIndex = normalizeAuthIndex(value);
  if (!authIndex || optionsByValue.has(authIndex)) return;
  optionsByValue.set(authIndex, buildReadableAuthIndexOption(authIndex, labelParts, label));
}

function addConfigAuthIndexOptions(
  optionsByValue: Map<string, AuthIndexOption>,
  config: AuthIndexSourceConfig | null | undefined
) {
  config?.geminiApiKeys?.forEach((entry, index) => {
    const label = `Gemini ${entry.prefix || entry.baseUrl || `key ${index + 1}`}`;
    addAuthIndexOption(
      optionsByValue,
      entry.authIndex,
      ['Gemini', entry.prefix || entry.baseUrl || `key ${index + 1}`, entry.baseUrl],
      label
    );
  });
  config?.codexApiKeys?.forEach((entry, index) => {
    const label = `Codex ${entry.prefix || entry.baseUrl || `key ${index + 1}`}`;
    addAuthIndexOption(
      optionsByValue,
      entry.authIndex,
      ['Codex', entry.prefix || entry.baseUrl || `key ${index + 1}`, entry.baseUrl],
      label
    );
  });
  config?.claudeApiKeys?.forEach((entry, index) => {
    const label = `Claude ${entry.prefix || entry.baseUrl || `key ${index + 1}`}`;
    addAuthIndexOption(
      optionsByValue,
      entry.authIndex,
      ['Claude', entry.prefix || entry.baseUrl || `key ${index + 1}`, entry.baseUrl],
      label
    );
  });
  config?.vertexApiKeys?.forEach((entry, index) => {
    const label = `Vertex ${entry.prefix || entry.baseUrl || `key ${index + 1}`}`;
    addAuthIndexOption(
      optionsByValue,
      entry.authIndex,
      ['Vertex', entry.prefix || entry.baseUrl || `key ${index + 1}`, entry.baseUrl],
      label
    );
  });
  config?.openaiCompatibility?.forEach((provider) => {
    const providerName = provider.name || provider.prefix || provider.baseUrl || 'provider';
    addAuthIndexOption(
      optionsByValue,
      provider.authIndex,
      ['OpenAI', providerName, provider.baseUrl],
      `OpenAI ${providerName}`
    );
    provider.apiKeyEntries?.forEach((entry, index) => {
      addAuthIndexOption(
        optionsByValue,
        entry.authIndex,
        ['OpenAI', providerName, provider.baseUrl, `key ${index + 1}`],
        `OpenAI ${providerName} key ${index + 1}`
      );
    });
  });
}

function buildAuthIndexOptions(
  config: Config | null | undefined,
  authFiles: AuthFileItem[],
  providerAuthConfig: AuthIndexSourceConfig | null | undefined
) {
  const optionsByValue = new Map<string, AuthIndexOption>();

  authFiles.forEach((file) => {
    addAuthIndexOption(
      optionsByValue,
      file.authIndex ?? file['auth_index'],
      buildAuthFileLabelParts(file),
      buildAuthFileOptionLabel(file)
    );
  });

  addConfigAuthIndexOptions(optionsByValue, config);
  addConfigAuthIndexOptions(optionsByValue, providerAuthConfig);

  return Array.from(optionsByValue.values()).sort((left, right) =>
    left.label.localeCompare(right.label, undefined, { numeric: true, sensitivity: 'base' })
  );
}

export const ApiKeysCardEditor = memo(function ApiKeysCardEditor({
  value,
  accessRules,
  disabled,
  onChange,
  onAccessRulesChange,
}: {
  value: string;
  accessRules: ApiKeyAccessRule[];
  disabled?: boolean;
  onChange: (nextValue: string) => void;
  onAccessRulesChange: (nextValue: ApiKeyAccessRule[]) => void;
}) {
  const { t } = useTranslation();
  const showNotification = useNotificationStore((state) => state.showNotification);
  const showConfirmation = useNotificationStore((state) => state.showConfirmation);
  const apiBase = useAuthStore((state) => state.apiBase);
  const managementKey = useAuthStore((state) => state.managementKey);
  const config = useConfigStore((state) => state.config);
  const usageServiceEnabled = useUsageServiceStore((state) => state.enabled);
  const usageServiceBase = useUsageServiceStore((state) => state.serviceBase);
  const apiKeys = useMemo(
    () =>
      value
        .split('\n')
        .map((key) => key.trim())
        .filter(Boolean),
    [value]
  );
  const [apiKeyIds, setApiKeyIds] = useState(() => apiKeys.map(() => makeClientId()));
  const renderApiKeyIds = useMemo(() => {
    if (apiKeyIds.length === apiKeys.length) return apiKeyIds;
    if (apiKeyIds.length > apiKeys.length) return apiKeyIds.slice(0, apiKeys.length);
    return [
      ...apiKeyIds,
      ...Array.from({ length: apiKeys.length - apiKeyIds.length }, () => makeClientId()),
    ];
  }, [apiKeyIds, apiKeys.length]);

  const apiKeyInputId = useId();
  const apiKeyHintId = `${apiKeyInputId}-hint`;
  const apiKeyErrorId = `${apiKeyInputId}-error`;
  const keyAliasInputId = `${apiKeyInputId}-alias`;
  const aliasModalInputId = useId();
  const aliasModalErrorId = `${aliasModalInputId}-error`;
  const [modalOpen, setModalOpen] = useState(false);
  const [editingApiKeyId, setEditingApiKeyId] = useState<string | null>(null);
  const [inputValue, setInputValue] = useState('');
  const [inputAliasValue, setInputAliasValue] = useState('');
  const [formError, setFormError] = useState('');
  const [apiKeyAliases, setApiKeyAliases] = useState<ApiKeyAlias[]>([]);
  const [aliasesLoading, setAliasesLoading] = useState(false);
  const [aliasesAvailable, setAliasesAvailable] = useState(false);
  const [aliasModalOpen, setAliasModalOpen] = useState(false);
  const [aliasEditingApiKeyId, setAliasEditingApiKeyId] = useState<string | null>(null);
  const [aliasInputValue, setAliasInputValue] = useState('');
  const [aliasFormError, setAliasFormError] = useState('');
  const [aliasSaving, setAliasSaving] = useState(false);
  const [accessModalOpen, setAccessModalOpen] = useState(false);
  const [accessEditingApiKeyId, setAccessEditingApiKeyId] = useState<string | null>(null);
  const [accessAllowedIndexesValue, setAccessAllowedIndexesValue] = useState('');
  const [accessAllowedIdsValue, setAccessAllowedIdsValue] = useState('');
  const [selectedAuthIndex, setSelectedAuthIndex] = useState('');
  const [authFiles, setAuthFiles] = useState<AuthFileItem[]>([]);
  const [authFilesLoading, setAuthFilesLoading] = useState(false);
  const [providerAuthConfig, setProviderAuthConfig] = useState<AuthIndexSourceConfig | null>(null);
  const [providerAuthLoading, setProviderAuthLoading] = useState(false);

  const aliasByHash = useMemo(() => {
    const map = new Map<string, ApiKeyAlias>();
    apiKeyAliases.forEach((item) => {
      const hash = String(item.apiKeyHash || '')
        .trim()
        .toLowerCase();
      const alias = String(item.alias || '').trim();
      if (!hash || !alias) return;
      map.set(hash, { ...item, apiKeyHash: hash, alias });
    });
    return map;
  }, [apiKeyAliases]);

  const accessRuleByKey = useMemo(() => {
    const map = new Map<string, ApiKeyAccessRule>();
    accessRules.forEach((rule) => {
      const key = rule.apiKey.trim();
      if (key && !map.has(key)) map.set(key, rule);
    });
    return map;
  }, [accessRules]);

  const normalizeAccessRulesForKeys = useCallback((keys: string[], rules: ApiKeyAccessRule[]) => {
    const byKey = new Map<string, ApiKeyAccessRule>();
    rules.forEach((rule) => {
      const key = rule.apiKey.trim();
      if (key && !byKey.has(key)) byKey.set(key, rule);
    });
    return keys
      .map((key, index) => {
        const trimmed = key.trim();
        if (!trimmed) return null;
        const existing = byKey.get(trimmed);
        return (
          existing ?? {
            id: `api-key-access-rule-${index}-${trimmed}`,
            apiKey: trimmed,
            allowedAuthIndexesText: '',
            allowedAuthIdsText: '',
          }
        );
      })
      .filter((rule): rule is ApiKeyAccessRule => Boolean(rule));
  }, []);

  const getAccessRuleForApiKey = (apiKey: string) =>
    accessRuleByKey.get(apiKey.trim()) ?? {
      id: `api-key-access-rule-${apiKey}`,
      apiKey,
      allowedAuthIndexesText: '',
      allowedAuthIdsText: '',
    };

  const getAllowedCount = (rule: ApiKeyAccessRule) =>
    splitAccessRuleListText(rule.allowedAuthIndexesText).length +
    splitAccessRuleListText(rule.allowedAuthIdsText).length;

  const authIndexOptions = useMemo(
    () => buildAuthIndexOptions(config, authFiles, providerAuthConfig),
    [authFiles, config, providerAuthConfig]
  );
  const authIndexOptionsLoading = authFilesLoading || providerAuthLoading;
  const authIndexOptionByValue = useMemo(
    () => new Map(authIndexOptions.map((option) => [option.value, option])),
    [authIndexOptions]
  );
  const allowedAuthIndexes = useMemo(
    () => splitAccessRuleListText(accessAllowedIndexesValue),
    [accessAllowedIndexesValue]
  );
  const allowedAuthIds = useMemo(
    () => splitAccessRuleListText(accessAllowedIdsValue),
    [accessAllowedIdsValue]
  );
  const activeAccessApiKey = useMemo(() => {
    const accessEditingIndex = accessEditingApiKeyId
      ? renderApiKeyIds.findIndex((id) => id === accessEditingApiKeyId)
      : -1;
    if (accessEditingIndex >= 0) {
      return apiKeys[accessEditingIndex] ?? '';
    }

    const editingIndex = editingApiKeyId
      ? renderApiKeyIds.findIndex((id) => id === editingApiKeyId)
      : -1;
    return editingIndex >= 0 ? (apiKeys[editingIndex] ?? '') : '';
  }, [accessEditingApiKeyId, apiKeys, editingApiKeyId, renderApiKeyIds]);
  const authIndexesUsedByOtherKeys = useMemo(() => {
    const activeKey = activeAccessApiKey.trim();
    const used = new Set<string>();
    accessRules.forEach((rule) => {
      const ruleKey = rule.apiKey.trim();
      if (activeKey && ruleKey === activeKey) return;
      splitAccessRuleListText(rule.allowedAuthIndexesText).forEach((authIndex) =>
        used.add(authIndex)
      );
    });
    return used;
  }, [accessRules, activeAccessApiKey]);
  const unusedAuthIndexOptions = useMemo(() => {
    const current = new Set(allowedAuthIndexes);
    return authIndexOptions.filter(
      (option) => !current.has(option.value) && !authIndexesUsedByOtherKeys.has(option.value)
    );
  }, [allowedAuthIndexes, authIndexOptions, authIndexesUsedByOtherKeys]);
  const unselectedAuthIndexOptions = useMemo(() => {
    const current = new Set(allowedAuthIndexes);
    return authIndexOptions.filter((option) => !current.has(option.value));
  }, [allowedAuthIndexes, authIndexOptions]);

  const resolveAliasServiceBase = useCallback(async (): Promise<string> => {
    if (usageServiceEnabled && usageServiceBase) {
      return usageServiceBase;
    }

    const candidates = buildUsageServiceBaseCandidates([apiBase, detectApiBaseFromLocation()]);

    for (const candidate of candidates) {
      try {
        const info = await usageServiceApi.getInfo(candidate);
        if (isUsageServiceId(info.service)) {
          return candidate;
        }
      } catch {
        // The regular CPA management API does not expose Usage Service metadata.
      }
    }

    return '';
  }, [apiBase, usageServiceBase, usageServiceEnabled]);

  useEffect(() => {
    let cancelled = false;

    const loadAliases = async () => {
      setAliasesLoading(true);
      try {
        const serviceBase = await resolveAliasServiceBase();
        if (cancelled) return;
        if (!serviceBase) {
          setAliasesAvailable(false);
          setApiKeyAliases([]);
          return;
        }
        const response = await usageServiceApi.getApiKeyAliases(serviceBase, managementKey);
        if (cancelled) return;
        setAliasesAvailable(true);
        setApiKeyAliases(Array.isArray(response.items) ? response.items : []);
      } catch {
        if (cancelled) return;
        setAliasesAvailable(false);
        setApiKeyAliases([]);
      } finally {
        if (!cancelled) {
          setAliasesLoading(false);
        }
      }
    };

    void loadAliases();

    return () => {
      cancelled = true;
    };
  }, [managementKey, resolveAliasServiceBase]);

  useEffect(() => {
    if (!accessModalOpen && !modalOpen) return;
    let cancelled = false;

    const loadAuthFiles = async () => {
      setAuthFilesLoading(true);
      try {
        const response = await authFilesApi.list();
        if (!cancelled) {
          setAuthFiles(Array.isArray(response.files) ? response.files : []);
        }
      } catch {
        if (!cancelled) {
          setAuthFiles([]);
        }
      } finally {
        if (!cancelled) {
          setAuthFilesLoading(false);
        }
      }
    };

    void loadAuthFiles();

    return () => {
      cancelled = true;
    };
  }, [accessModalOpen, modalOpen]);

  useEffect(() => {
    if (!accessModalOpen && !modalOpen) return;
    let cancelled = false;

    const loadProviderAuthConfig = async () => {
      setProviderAuthLoading(true);
      try {
        const [gemini, codex, claude, vertex, openai] = await Promise.allSettled([
          providersApi.getGeminiKeys(),
          providersApi.getCodexConfigs(),
          providersApi.getClaudeConfigs(),
          providersApi.getVertexConfigs(),
          providersApi.getOpenAIProviders(),
        ] as const);
        if (cancelled) return;

        const next: AuthIndexSourceConfig = {};
        if (gemini.status === 'fulfilled') next.geminiApiKeys = gemini.value;
        if (codex.status === 'fulfilled') next.codexApiKeys = codex.value;
        if (claude.status === 'fulfilled') next.claudeApiKeys = claude.value;
        if (vertex.status === 'fulfilled') next.vertexApiKeys = vertex.value;
        if (openai.status === 'fulfilled') next.openaiCompatibility = openai.value;
        setProviderAuthConfig(next);
      } finally {
        if (!cancelled) {
          setProviderAuthLoading(false);
        }
      }
    };

    void loadProviderAuthConfig();

    return () => {
      cancelled = true;
    };
  }, [accessModalOpen, modalOpen]);

  function generateSecureApiKey(): string {
    const charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const array = new Uint8Array(64);
    crypto.getRandomValues(array);
    return 'sk-' + Array.from(array, (b) => charset[b % charset.length]).join('');
  }

  const getApiKeyHash = (apiKey: string) => sha256Hex(apiKey).toLowerCase();

  const collectActiveApiKeyHashes = (keys: string[]): string[] => {
    const set = new Set<string>();
    keys.forEach((key) => {
      const hash = getApiKeyHash(key);
      if (hash) set.add(hash);
    });
    return Array.from(set);
  };

  const getAliasForApiKey = (apiKey: string) => {
    const hash = getApiKeyHash(apiKey);
    return hash ? (aliasByHash.get(hash)?.alias ?? '') : '';
  };

  const normalizeAliasKey = (alias: string) => alias.trim().toLowerCase();

  const isDuplicateAlias = (
    alias: string,
    currentApiKeyHash: string,
    activeHashesSet?: Set<string>
  ) => {
    const aliasKey = normalizeAliasKey(alias);
    const currentHash = currentApiKeyHash.trim().toLowerCase();
    if (!aliasKey) return false;
    return apiKeyAliases.some((item) => {
      const itemHash = String(item.apiKeyHash || '')
        .trim()
        .toLowerCase();
      if (itemHash === currentHash) return false;
      if (normalizeAliasKey(String(item.alias || '')) !== aliasKey) return false;
      // Only check conflicts among active hashes; orphaned alias mappings should not block edits.
      if (activeHashesSet && !activeHashesSet.has(itemHash)) return false;
      return true;
    });
  };

  const validateAlias = (
    alias: string,
    currentApiKeyHash: string = '',
    activeHashesSet?: Set<string>
  ) => {
    const trimmed = alias.trim();
    if (!trimmed) {
      return t('config_management.visual.api_keys.alias_error_empty');
    }
    if (Array.from(trimmed).length > 120) {
      return t('config_management.visual.api_keys.alias_error_too_long');
    }
    if (isDuplicateAlias(trimmed, currentApiKeyHash, activeHashesSet)) {
      return t('config_management.visual.api_keys.alias_error_duplicate');
    }
    return '';
  };

  const saveAliasForKey = async (apiKey: string, alias: string, activeApiKeyHashes?: string[]) => {
    const apiKeyHash = getApiKeyHash(apiKey);
    const trimmedAlias = alias.trim();
    if (!apiKeyHash) {
      throw new Error(t('config_management.visual.api_keys.error_empty'));
    }
    const activeHashesSet =
      activeApiKeyHashes && activeApiKeyHashes.length > 0
        ? new Set(activeApiKeyHashes.map((hash) => hash.toLowerCase()))
        : undefined;
    const validationError = validateAlias(trimmedAlias, apiKeyHash, activeHashesSet);
    if (validationError) {
      throw new Error(validationError);
    }

    const serviceBase = await resolveAliasServiceBase();
    if (!serviceBase) {
      throw new Error(t('config_management.visual.api_keys.alias_unavailable'));
    }

    const response = await usageServiceApi.saveApiKeyAliases(
      serviceBase,
      [{ apiKeyHash, alias: trimmedAlias }],
      managementKey,
      activeApiKeyHashes
    );
    setAliasesAvailable(true);
    setApiKeyAliases(Array.isArray(response.items) ? response.items : []);
  };

  const deleteAliasForHash = async (apiKeyHash: string) => {
    const serviceBase = await resolveAliasServiceBase();
    if (!serviceBase) {
      throw new Error(t('config_management.visual.api_keys.alias_unavailable'));
    }

    await usageServiceApi.deleteApiKeyAlias(serviceBase, apiKeyHash, managementKey);
    setApiKeyAliases((previous) =>
      previous.filter((item) => item.apiKeyHash.toLowerCase() !== apiKeyHash.toLowerCase())
    );
  };

  const getAliasErrorMessage = (error: unknown) => {
    if (
      error &&
      typeof error === 'object' &&
      (error as { code?: unknown }).code === 'api_key_alias_duplicate'
    ) {
      return t('config_management.visual.api_keys.alias_error_duplicate');
    }
    return error instanceof Error ? error.message : String(error);
  };

  const openAddModal = () => {
    setEditingApiKeyId(null);
    setInputValue('');
    setInputAliasValue('');
    setAccessAllowedIndexesValue('');
    setAccessAllowedIdsValue('');
    setSelectedAuthIndex('');
    setFormError('');
    setModalOpen(true);
  };

  const openEditModal = (apiKeyId: string) => {
    const editingIndex = renderApiKeyIds.findIndex((id) => id === apiKeyId);
    const editingKey = apiKeys[editingIndex] ?? '';
    const rule = getAccessRuleForApiKey(editingKey);
    setEditingApiKeyId(apiKeyId);
    setInputValue(editingKey);
    setInputAliasValue(getAliasForApiKey(editingKey));
    setAccessAllowedIndexesValue(rule.allowedAuthIndexesText);
    setAccessAllowedIdsValue(rule.allowedAuthIdsText);
    setSelectedAuthIndex('');
    setFormError('');
    setModalOpen(true);
  };

  const closeModal = () => {
    setModalOpen(false);
    setInputValue('');
    setInputAliasValue('');
    setEditingApiKeyId(null);
    setAccessAllowedIndexesValue('');
    setAccessAllowedIdsValue('');
    setSelectedAuthIndex('');
    setFormError('');
  };

  const openAliasModal = (apiKeyId: string) => {
    const editingIndex = renderApiKeyIds.findIndex((id) => id === apiKeyId);
    const editingKey = apiKeys[editingIndex] ?? '';
    setAliasEditingApiKeyId(apiKeyId);
    setAliasInputValue(getAliasForApiKey(editingKey));
    setAliasFormError('');
    setAliasModalOpen(true);
  };

  const openAccessModal = (apiKeyId: string) => {
    const editingIndex = renderApiKeyIds.findIndex((id) => id === apiKeyId);
    const editingKey = apiKeys[editingIndex] ?? '';
    const rule = getAccessRuleForApiKey(editingKey);
    setAccessEditingApiKeyId(apiKeyId);
    setAccessAllowedIndexesValue(rule.allowedAuthIndexesText);
    setAccessAllowedIdsValue(rule.allowedAuthIdsText);
    setSelectedAuthIndex('');
    setAccessModalOpen(true);
  };

  const closeAliasModal = () => {
    setAliasModalOpen(false);
    setAliasEditingApiKeyId(null);
    setAliasInputValue('');
    setAliasFormError('');
  };

  const closeAccessModal = () => {
    setAccessModalOpen(false);
    setAccessEditingApiKeyId(null);
    setAccessAllowedIndexesValue('');
    setAccessAllowedIdsValue('');
    setSelectedAuthIndex('');
  };

  const updateApiKeys = (nextKeys: string[]) => {
    onChange(nextKeys.join('\n'));
  };

  const handleDelete = (apiKeyId: string) => {
    const index = renderApiKeyIds.findIndex((id) => id === apiKeyId);
    if (index < 0) return;
    const removedKey = apiKeys[index] ?? '';
    setApiKeyIds(renderApiKeyIds.filter((id) => id !== apiKeyId));
    const nextKeys = apiKeys.filter((_, i) => i !== index);
    updateApiKeys(nextKeys);
    onAccessRulesChange(
      normalizeAccessRulesForKeys(
        nextKeys,
        accessRules.filter((rule) => rule.apiKey.trim() !== removedKey.trim())
      )
    );
  };

  const handleSave = async () => {
    const trimmed = inputValue.trim();
    const trimmedAlias = inputAliasValue.trim();
    if (!trimmed) {
      setFormError(t('config_management.visual.api_keys.error_empty'));
      return;
    }
    if (!isValidApiKeyCharset(trimmed)) {
      setFormError(t('config_management.visual.api_keys.error_invalid'));
      return;
    }

    const editingIndex = editingApiKeyId
      ? renderApiKeyIds.findIndex((id) => id === editingApiKeyId)
      : -1;
    const previousKey = editingIndex >= 0 ? (apiKeys[editingIndex] ?? '') : '';
    const nextKeys =
      editingApiKeyId === null
        ? [...apiKeys, trimmed]
        : apiKeys.map((key, idx) => (idx === editingIndex ? trimmed : key));
    const nextActiveHashes = collectActiveApiKeyHashes(nextKeys);

    if (trimmedAlias) {
      const aliasError = validateAlias(
        trimmedAlias,
        getApiKeyHash(trimmed),
        new Set(nextActiveHashes)
      );
      if (aliasError) {
        setFormError(aliasError);
        return;
      }
      if (!aliasesAvailable) {
        setFormError(t('config_management.visual.api_keys.alias_unavailable'));
        return;
      }
    }

    if (trimmedAlias) {
      try {
        setAliasSaving(true);
        await saveAliasForKey(trimmed, trimmedAlias, nextActiveHashes);
        showNotification(t('config_management.visual.api_keys.alias_saved'), 'success');
      } catch (error) {
        setFormError(getAliasErrorMessage(error));
        setAliasSaving(false);
        return;
      }
      setAliasSaving(false);
    }

    if (editingApiKeyId === null) {
      setApiKeyIds([...renderApiKeyIds, makeClientId()]);
    }
    updateApiKeys(nextKeys);
    const renamedRules = accessRules.map((rule) =>
      previousKey && rule.apiKey.trim() === previousKey.trim() ? { ...rule, apiKey: trimmed } : rule
    );
    const existingRule = getAccessRuleForApiKey(previousKey || trimmed);
    const nextRule: ApiKeyAccessRule = {
      ...existingRule,
      apiKey: trimmed,
      allowedAuthIndexesText: accessAllowedIndexesValue,
      allowedAuthIdsText: accessAllowedIdsValue,
    };
    const nextRules = renamedRules.some((rule) => rule.apiKey.trim() === trimmed)
      ? renamedRules.map((rule) => (rule.apiKey.trim() === trimmed ? nextRule : rule))
      : [...renamedRules, nextRule];
    onAccessRulesChange(normalizeAccessRulesForKeys(nextKeys, nextRules));
    closeModal();
  };

  const handleAccessSave = () => {
    const editingIndex = accessEditingApiKeyId
      ? renderApiKeyIds.findIndex((id) => id === accessEditingApiKeyId)
      : -1;
    const editingKey = apiKeys[editingIndex] ?? '';
    if (!editingKey.trim()) return;

    const currentRule = getAccessRuleForApiKey(editingKey);
    const nextRule: ApiKeyAccessRule = {
      ...currentRule,
      apiKey: editingKey.trim(),
      allowedAuthIndexesText: accessAllowedIndexesValue,
      allowedAuthIdsText: accessAllowedIdsValue,
    };
    const nextRules = accessRules.some((rule) => rule.apiKey.trim() === editingKey.trim())
      ? accessRules.map((rule) => (rule.apiKey.trim() === editingKey.trim() ? nextRule : rule))
      : [...accessRules, nextRule];
    onAccessRulesChange(normalizeAccessRulesForKeys(apiKeys, nextRules));
    closeAccessModal();
  };

  const handleAddSelectedAuthIndex = () => {
    const authIndex = selectedAuthIndex.trim();
    if (!authIndex) return;
    const existing = splitAccessRuleListText(accessAllowedIndexesValue);
    if (existing.includes(authIndex)) {
      return;
    }
    setAccessAllowedIndexesValue([...existing, authIndex].join('\n'));
    setSelectedAuthIndex('');
  };

  const handleAddUnusedAuthIndexes = () => {
    if (unusedAuthIndexOptions.length === 0) return;
    const existing = splitAccessRuleListText(accessAllowedIndexesValue);
    const existingSet = new Set(existing);
    const next = [...existing];
    unusedAuthIndexOptions.forEach((option) => {
      if (existingSet.has(option.value)) return;
      existingSet.add(option.value);
      next.push(option.value);
    });
    setAccessAllowedIndexesValue(next.join('\n'));
    setSelectedAuthIndex('');
  };

  const handleAddAllAuthIndexes = () => {
    if (unselectedAuthIndexOptions.length === 0) return;
    const existing = splitAccessRuleListText(accessAllowedIndexesValue);
    const existingSet = new Set(existing);
    const next = [...existing];
    unselectedAuthIndexOptions.forEach((option) => {
      if (existingSet.has(option.value)) return;
      existingSet.add(option.value);
      next.push(option.value);
    });
    setAccessAllowedIndexesValue(next.join('\n'));
    setSelectedAuthIndex('');
  };

  const handleRemoveAllowedAuthIndex = (authIndex: string) => {
    const next = allowedAuthIndexes.filter((item) => item !== authIndex);
    setAccessAllowedIndexesValue(next.join('\n'));
  };

  const handleRemoveAllowedAuthId = (authId: string) => {
    const next = allowedAuthIds.filter((item) => item !== authId);
    setAccessAllowedIdsValue(next.join('\n'));
  };

  const renderAllowedAuthIndexList = () => (
    <div className={styles.allowedCredentialList}>
      {allowedAuthIndexes.length === 0 ? (
        <div className={styles.allowedCredentialEmpty}>
          {t('config_management.visual.api_key_access_rules.status_denied')}
        </div>
      ) : (
        allowedAuthIndexes.map((authIndex) => {
          const option = authIndexOptionByValue.get(authIndex);
          return (
            <div
              key={authIndex}
              className={styles.allowedCredentialItem}
              title={option?.label ?? `#${authIndex}`}
            >
              <div className={styles.allowedCredentialMain}>
                <div className={styles.allowedCredentialTitle}>
                  {option?.label ?? `#${authIndex}`}
                </div>
              </div>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => handleRemoveAllowedAuthIndex(authIndex)}
                disabled={disabled}
              >
                {t('config_management.visual.common.delete')}
              </Button>
            </div>
          );
        })
      )}
    </div>
  );

  const renderAllowedAuthIdList = () =>
    allowedAuthIds.length === 0 ? null : (
      <div className={styles.allowedCredentialList}>
        {allowedAuthIds.map((authId) => (
          <div key={authId} className={styles.allowedCredentialItem} title={`auth ID: ${authId}`}>
            <div className={styles.allowedCredentialMain}>
              <div className={styles.allowedCredentialTitle}>{authId}</div>
              <div className={styles.allowedCredentialMeta}>auth ID</div>
            </div>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => handleRemoveAllowedAuthId(authId)}
              disabled={disabled}
            >
              {t('config_management.visual.common.delete')}
            </Button>
          </div>
        ))}
      </div>
    );

  const renderAuthIndexPicker = () => (
    <div className="form-group">
      <label className={styles.blockLabel}>
        {t('config_management.visual.api_keys.auth_index_select')}
      </label>
      <div className={styles.authIndexPickerRow}>
        <Select
          className={styles.authIndexSelect}
          dropdownClassName={styles.authIndexSelectDropdown}
          dropdownWidth={320}
          fullWidth={false}
          searchable
          searchPlaceholder={t('config_management.visual.api_keys.auth_index_search_placeholder')}
          emptyText={t('config_management.visual.api_keys.auth_index_search_empty')}
          value={selectedAuthIndex}
          options={authIndexOptions}
          onChange={setSelectedAuthIndex}
          placeholder={
            authIndexOptionsLoading
              ? t('common.loading')
              : t('config_management.visual.api_keys.auth_index_select_placeholder')
          }
          disabled={disabled || authIndexOptions.length === 0}
          ariaLabel={t('config_management.visual.api_keys.auth_index_select')}
        />
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={handleAddSelectedAuthIndex}
          disabled={disabled || !selectedAuthIndex}
        >
          {t('config_management.visual.api_keys.auth_index_add')}
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className={styles.authIndexBulkButton}
          onClick={handleAddUnusedAuthIndexes}
          disabled={disabled || unusedAuthIndexOptions.length === 0}
        >
          {t('config_management.visual.api_keys.auth_index_add_unused')}
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className={styles.authIndexBulkButton}
          onClick={handleAddAllAuthIndexes}
          disabled={disabled || unselectedAuthIndexOptions.length === 0}
        >
          {t('config_management.visual.api_keys.auth_index_add_all')}
        </Button>
      </div>
      {authIndexOptions.length === 0 && !authIndexOptionsLoading ? (
        <div className="hint">{t('config_management.visual.api_keys.auth_index_empty')}</div>
      ) : null}
    </div>
  );

  const renderAccessRuleFields = () => (
    <>
      {renderAuthIndexPicker()}
      <div className="form-group">
        <label className={styles.blockLabel}>
          {t('config_management.visual.api_key_access_rules.allowed_indexes')}
        </label>
        {renderAllowedAuthIndexList()}
        <div className="hint">{t('config_management.visual.api_keys.access_hint')}</div>
      </div>
      {allowedAuthIds.length > 0 ? (
        <div className="form-group">
          <label className={styles.blockLabel}>
            {t('config_management.visual.api_key_access_rules.allowed_ids')}
          </label>
          {renderAllowedAuthIdList()}
          <div className="hint">{t('config_management.visual.api_keys.auth_id_hint')}</div>
        </div>
      ) : null}
    </>
  );

  const handleAliasSave = async () => {
    const editingIndex = aliasEditingApiKeyId
      ? renderApiKeyIds.findIndex((id) => id === aliasEditingApiKeyId)
      : -1;
    const editingKey = apiKeys[editingIndex] ?? '';
    const currentActiveHashes = collectActiveApiKeyHashes(apiKeys);
    const aliasError = validateAlias(
      aliasInputValue,
      getApiKeyHash(editingKey),
      new Set(currentActiveHashes)
    );
    if (aliasError) {
      setAliasFormError(aliasError);
      return;
    }

    setAliasSaving(true);
    try {
      await saveAliasForKey(editingKey, aliasInputValue, currentActiveHashes);
      showNotification(t('config_management.visual.api_keys.alias_saved'), 'success');
      closeAliasModal();
    } catch (error) {
      setAliasFormError(getAliasErrorMessage(error));
    } finally {
      setAliasSaving(false);
    }
  };

  const handleAliasDelete = () => {
    const editingIndex = aliasEditingApiKeyId
      ? renderApiKeyIds.findIndex((id) => id === aliasEditingApiKeyId)
      : -1;
    const editingKey = apiKeys[editingIndex] ?? '';
    const apiKeyHash = getApiKeyHash(editingKey);
    if (!apiKeyHash || !aliasByHash.has(apiKeyHash)) return;

    showConfirmation({
      title: t('config_management.visual.api_keys.alias_delete_title'),
      message: t('config_management.visual.api_keys.alias_delete_confirm'),
      confirmText: t('config_management.visual.api_keys.alias_delete'),
      variant: 'danger',
      onConfirm: async () => {
        setAliasSaving(true);
        try {
          await deleteAliasForHash(apiKeyHash);
          showNotification(t('config_management.visual.api_keys.alias_deleted'), 'success');
          closeAliasModal();
        } catch (error) {
          setAliasFormError(getAliasErrorMessage(error));
        } finally {
          setAliasSaving(false);
        }
      },
    });
  };

  const handleCopy = async (apiKey: string) => {
    const copied = await copyToClipboard(apiKey);
    showNotification(
      t(copied ? 'notification.link_copied' : 'notification.copy_failed'),
      copied ? 'success' : 'error'
    );
  };

  const handleGenerate = () => {
    setInputValue(generateSecureApiKey());
    setFormError('');
  };

  return (
    <div className="form-group" style={{ marginBottom: 0 }}>
      <div className={styles.blockHeaderRow}>
        <label style={{ margin: 0 }}>{t('config_management.visual.api_keys.label')}</label>
        <Button size="sm" onClick={openAddModal} disabled={disabled}>
          {t('config_management.visual.api_keys.add')}
        </Button>
      </div>

      {apiKeys.length === 0 ? (
        <div className={styles.emptyState}>{t('config_management.visual.api_keys.empty')}</div>
      ) : (
        <div className="item-list" style={{ marginTop: 4 }}>
          {apiKeys.map((key, index) => {
            const apiKeyHash = getApiKeyHash(key);
            const alias = apiKeyHash ? (aliasByHash.get(apiKeyHash)?.alias ?? '') : '';
            const accessRule = getAccessRuleForApiKey(key);
            const allowedCount = getAllowedCount(accessRule);
            return (
              <div key={renderApiKeyIds[index] ?? `${key}-${index}`} className="item-row">
                <div className="item-meta">
                  <div className="item-title">
                    {alias || t('config_management.visual.api_keys.input_label')}
                  </div>
                  <div className="item-subtitle">{maskApiKey(String(key || ''))}</div>
                  <div className={styles.accessRuleStatus}>
                    {allowedCount > 0
                      ? t('config_management.visual.api_key_access_rules.status_allowed', {
                          count: allowedCount,
                        })
                      : t('config_management.visual.api_key_access_rules.status_denied')}
                  </div>
                </div>
                <div className="item-actions">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => openAccessModal(renderApiKeyIds[index] ?? '')}
                    disabled={disabled}
                  >
                    {t('config_management.visual.api_keys.access_action')}
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => openAliasModal(renderApiKeyIds[index] ?? '')}
                    disabled={disabled || aliasesLoading || !aliasesAvailable}
                  >
                    {t('config_management.visual.api_keys.alias_action')}
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => handleCopy(key)}
                    disabled={disabled}
                  >
                    {t('common.copy')}
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => openEditModal(renderApiKeyIds[index] ?? '')}
                    disabled={disabled}
                  >
                    {t('config_management.visual.common.edit')}
                  </Button>
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={() => handleDelete(renderApiKeyIds[index] ?? '')}
                    disabled={disabled}
                  >
                    {t('config_management.visual.common.delete')}
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="hint">{t('config_management.visual.api_keys.hint')}</div>
      {!aliasesAvailable && !aliasesLoading ? (
        <div className="hint">{t('config_management.visual.api_keys.alias_unavailable')}</div>
      ) : null}

      <Modal
        open={modalOpen}
        onClose={closeModal}
        title={
          editingApiKeyId !== null
            ? t('config_management.visual.api_keys.edit_title')
            : t('config_management.visual.api_keys.add_title')
        }
        footer={
          <>
            <Button variant="secondary" onClick={closeModal} disabled={disabled || aliasSaving}>
              {t('config_management.visual.common.cancel')}
            </Button>
            <Button onClick={handleSave} disabled={disabled || aliasSaving}>
              {editingApiKeyId !== null
                ? t('config_management.visual.common.update')
                : t('config_management.visual.common.add')}
            </Button>
          </>
        }
      >
        <div className="form-group">
          <label htmlFor={apiKeyInputId}>
            {t('config_management.visual.api_keys.input_label')}
          </label>
          <div className={styles.apiKeyModalInputRow}>
            <input
              id={apiKeyInputId}
              className="input"
              placeholder={t('config_management.visual.api_keys.input_placeholder')}
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              disabled={disabled}
              aria-describedby={formError ? `${apiKeyErrorId} ${apiKeyHintId}` : apiKeyHintId}
              aria-invalid={Boolean(formError)}
            />
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={handleGenerate}
              disabled={disabled}
            >
              {t('config_management.visual.api_keys.generate')}
            </Button>
          </div>
          <div id={apiKeyHintId} className="hint">
            {t('config_management.visual.api_keys.input_hint')}
          </div>
          <div className="form-group">
            <label htmlFor={keyAliasInputId}>
              {t('config_management.visual.api_keys.alias_label')}
            </label>
            <input
              id={keyAliasInputId}
              className="input"
              placeholder={t('config_management.visual.api_keys.alias_placeholder')}
              value={inputAliasValue}
              onChange={(e) => setInputAliasValue(e.target.value)}
              disabled={disabled || aliasesLoading || !aliasesAvailable}
              maxLength={120}
            />
            <div className="hint">{t('config_management.visual.api_keys.alias_hint')}</div>
          </div>
          {renderAccessRuleFields()}
          {formError && (
            <div id={apiKeyErrorId} className="error-box">
              {formError}
            </div>
          )}
        </div>
      </Modal>

      <Modal
        open={aliasModalOpen}
        onClose={closeAliasModal}
        title={t('config_management.visual.api_keys.alias_title')}
        footer={
          <>
            {aliasEditingApiKeyId &&
            aliasByHash.has(
              getApiKeyHash(
                apiKeys[renderApiKeyIds.findIndex((id) => id === aliasEditingApiKeyId)] ?? ''
              )
            ) ? (
              <Button
                variant="danger"
                onClick={handleAliasDelete}
                disabled={disabled || aliasSaving}
              >
                {t('config_management.visual.api_keys.alias_delete')}
              </Button>
            ) : null}
            <Button
              variant="secondary"
              onClick={closeAliasModal}
              disabled={disabled || aliasSaving}
            >
              {t('config_management.visual.common.cancel')}
            </Button>
            <Button onClick={handleAliasSave} disabled={disabled || aliasSaving}>
              {t('config_management.visual.common.update')}
            </Button>
          </>
        }
      >
        <div className="form-group">
          <label htmlFor={aliasModalInputId}>
            {t('config_management.visual.api_keys.alias_label')}
          </label>
          <input
            id={aliasModalInputId}
            className="input"
            placeholder={t('config_management.visual.api_keys.alias_placeholder')}
            value={aliasInputValue}
            onChange={(e) => {
              setAliasInputValue(e.target.value);
              setAliasFormError('');
            }}
            disabled={disabled || aliasSaving}
            maxLength={120}
            aria-describedby={aliasFormError ? aliasModalErrorId : undefined}
            aria-invalid={Boolean(aliasFormError)}
          />
          <div className="hint">{t('config_management.visual.api_keys.alias_hint')}</div>
          {aliasFormError && (
            <div id={aliasModalErrorId} className="error-box">
              {aliasFormError}
            </div>
          )}
        </div>
      </Modal>

      <Modal
        open={accessModalOpen}
        onClose={closeAccessModal}
        title={t('config_management.visual.api_keys.access_title')}
        footer={
          <>
            <Button variant="secondary" onClick={closeAccessModal} disabled={disabled}>
              {t('config_management.visual.common.cancel')}
            </Button>
            <Button onClick={handleAccessSave} disabled={disabled}>
              {t('config_management.visual.common.update')}
            </Button>
          </>
        }
      >
        {renderAccessRuleFields()}
      </Modal>
    </div>
  );
});

function splitAccessRuleListText(value: string): string[] {
  const items = value
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item)) return false;
    seen.add(item);
    return true;
  });
}

const StringListEditor = memo(function StringListEditor({
  value,
  disabled,
  placeholder,
  inputAriaLabel,
  onChange,
}: {
  value: string[];
  disabled?: boolean;
  placeholder?: string;
  inputAriaLabel?: string;
  onChange: (next: string[]) => void;
}) {
  const { t } = useTranslation();
  const items = value.length ? value : [];
  const [itemIds, setItemIds] = useState(() => items.map(() => makeClientId()));
  const renderItemIds = useMemo(() => {
    if (itemIds.length === items.length) return itemIds;
    if (itemIds.length > items.length) return itemIds.slice(0, items.length);
    return [
      ...itemIds,
      ...Array.from({ length: items.length - itemIds.length }, () => makeClientId()),
    ];
  }, [itemIds, items.length]);

  const updateItem = (index: number, nextValue: string) =>
    onChange(items.map((item, i) => (i === index ? nextValue : item)));
  const addItem = () => {
    setItemIds([...renderItemIds, makeClientId()]);
    onChange([...items, '']);
  };
  const removeItem = (index: number) => {
    setItemIds(renderItemIds.filter((_, i) => i !== index));
    onChange(items.filter((_, i) => i !== index));
  };

  return (
    <div className={styles.stringList}>
      {items.map((item, index) => (
        <div key={renderItemIds[index] ?? `item-${index}`} className={styles.stringListRow}>
          <ExpandableInput
            placeholder={placeholder}
            ariaLabel={inputAriaLabel ?? placeholder}
            value={item}
            onChange={(nextValue) => updateItem(index, nextValue)}
            disabled={disabled}
          />
          <Button variant="ghost" size="sm" onClick={() => removeItem(index)} disabled={disabled}>
            {t('config_management.visual.common.delete')}
          </Button>
        </div>
      ))}
      <div className={styles.actionRow}>
        <Button variant="secondary" size="sm" onClick={addItem} disabled={disabled}>
          {t('config_management.visual.common.add')}
        </Button>
      </div>
    </div>
  );
});

function hasPayloadModelAdvancedSettings(model: PayloadModelEntry) {
  return Boolean(
    model.fromProtocol ||
    (model.headers?.length ?? 0) > 0 ||
    (model.match?.length ?? 0) > 0 ||
    (model.notMatch?.length ?? 0) > 0 ||
    (model.exist?.length ?? 0) > 0 ||
    (model.notExist?.length ?? 0) > 0
  );
}

export const PayloadRulesEditor = memo(function PayloadRulesEditor({
  value,
  disabled,
  protocolFirst = false,
  rawJsonValues = false,
  onChange,
}: {
  value: PayloadRule[];
  disabled?: boolean;
  protocolFirst?: boolean;
  rawJsonValues?: boolean;
  onChange: (next: PayloadRule[]) => void;
}) {
  const { t } = useTranslation();
  const rules = value;
  const protocolOptions = useMemo(() => buildProtocolOptions(t, rules), [rules, t]);
  const fromProtocolOptions = useMemo(
    () => [
      {
        value: '',
        label: t('config_management.visual.payload_rules.provider_default'),
      },
      {
        value: 'openai',
        label: t('config_management.visual.payload_rules.provider_openai'),
      },
      {
        value: 'responses',
        label: t('config_management.visual.payload_rules.provider_responses'),
      },
      {
        value: 'gemini',
        label: t('config_management.visual.payload_rules.provider_gemini'),
      },
      {
        value: 'claude',
        label: t('config_management.visual.payload_rules.provider_claude'),
      },
    ],
    [t]
  );
  const payloadValueTypeOptions = useMemo(
    () =>
      VISUAL_CONFIG_PAYLOAD_VALUE_TYPE_OPTIONS.map((option) => ({
        value: option.value,
        label: t(option.labelKey, { defaultValue: option.defaultLabel }),
      })),
    [t]
  );
  const booleanValueOptions = useMemo(
    () => [
      { value: 'true', label: t('config_management.visual.payload_rules.boolean_true') },
      { value: 'false', label: t('config_management.visual.payload_rules.boolean_false') },
    ],
    [t]
  );
  const [modelAdvancedOverrides, setModelAdvancedOverrides] = useState<Record<string, boolean>>({});

  const addRule = () => onChange([...rules, { id: makeClientId(), models: [], params: [] }]);
  const removeRule = (ruleIndex: number) => onChange(rules.filter((_, i) => i !== ruleIndex));

  const updateRule = (ruleIndex: number, patch: Partial<PayloadRule>) =>
    onChange(rules.map((rule, i) => (i === ruleIndex ? { ...rule, ...patch } : rule)));

  const addModel = (ruleIndex: number) => {
    const rule = rules[ruleIndex];
    const nextModel: PayloadModelEntry = { id: makeClientId(), name: '', protocol: undefined };
    updateRule(ruleIndex, { models: [...rule.models, nextModel] });
  };

  const removeModel = (ruleIndex: number, modelIndex: number) => {
    const rule = rules[ruleIndex];
    updateRule(ruleIndex, { models: rule.models.filter((_, i) => i !== modelIndex) });
  };

  const updateModel = (
    ruleIndex: number,
    modelIndex: number,
    patch: Partial<PayloadModelEntry>
  ) => {
    const rule = rules[ruleIndex];
    updateRule(ruleIndex, {
      models: rule.models.map((m, i) => (i === modelIndex ? { ...m, ...patch } : m)),
    });
  };

  const toggleModelAdvanced = (modelId: string, defaultExpanded: boolean) => {
    setModelAdvancedOverrides((current) => ({
      ...current,
      [modelId]: !(current[modelId] ?? defaultExpanded),
    }));
  };

  const addHeader = (ruleIndex: number, modelIndex: number) => {
    const rule = rules[ruleIndex];
    const model = rule.models[modelIndex];
    updateModel(ruleIndex, modelIndex, {
      headers: [...(model.headers ?? []), { id: makeClientId(), name: '', value: '' }],
    });
  };

  const updateHeader = (
    ruleIndex: number,
    modelIndex: number,
    headerIndex: number,
    patch: Partial<PayloadHeaderEntry>
  ) => {
    const model = rules[ruleIndex].models[modelIndex];
    updateModel(ruleIndex, modelIndex, {
      headers: (model.headers ?? []).map((header, i) =>
        i === headerIndex ? { ...header, ...patch } : header
      ),
    });
  };

  const removeHeader = (ruleIndex: number, modelIndex: number, headerIndex: number) => {
    const model = rules[ruleIndex].models[modelIndex];
    updateModel(ruleIndex, modelIndex, {
      headers: (model.headers ?? []).filter((_, i) => i !== headerIndex),
    });
  };

  const addCondition = (ruleIndex: number, modelIndex: number, key: 'match' | 'notMatch') => {
    const model = rules[ruleIndex].models[modelIndex];
    updateModel(ruleIndex, modelIndex, {
      [key]: [
        ...(model[key] ?? []),
        { id: makeClientId(), path: '', valueType: 'string', value: '' },
      ],
    });
  };

  const updateCondition = (
    ruleIndex: number,
    modelIndex: number,
    key: 'match' | 'notMatch',
    conditionIndex: number,
    patch: Partial<PayloadParamEntry>
  ) => {
    const model = rules[ruleIndex].models[modelIndex];
    updateModel(ruleIndex, modelIndex, {
      [key]: (model[key] ?? []).map((condition, i) =>
        i === conditionIndex ? { ...condition, ...patch } : condition
      ),
    });
  };

  const removeCondition = (
    ruleIndex: number,
    modelIndex: number,
    key: 'match' | 'notMatch',
    conditionIndex: number
  ) => {
    const model = rules[ruleIndex].models[modelIndex];
    updateModel(ruleIndex, modelIndex, {
      [key]: (model[key] ?? []).filter((_, i) => i !== conditionIndex),
    });
  };

  const addParam = (ruleIndex: number) => {
    const rule = rules[ruleIndex];
    const nextParam: PayloadParamEntry = {
      id: makeClientId(),
      path: '',
      valueType: rawJsonValues ? 'json' : 'string',
      value: '',
    };
    updateRule(ruleIndex, { params: [...rule.params, nextParam] });
  };

  const removeParam = (ruleIndex: number, paramIndex: number) => {
    const rule = rules[ruleIndex];
    updateRule(ruleIndex, { params: rule.params.filter((_, i) => i !== paramIndex) });
  };

  const updateParam = (
    ruleIndex: number,
    paramIndex: number,
    patch: Partial<PayloadParamEntry>
  ) => {
    const rule = rules[ruleIndex];
    updateRule(ruleIndex, {
      params: rule.params.map((p, i) => (i === paramIndex ? { ...p, ...patch } : p)),
    });
  };

  const getValuePlaceholder = (valueType: PayloadParamValueType) => {
    switch (valueType) {
      case 'string':
        return t('config_management.visual.payload_rules.value_string');
      case 'number':
        return t('config_management.visual.payload_rules.value_number');
      case 'boolean':
        return t('config_management.visual.payload_rules.value_boolean');
      case 'json':
        return t('config_management.visual.payload_rules.value_json');
      default:
        return t('config_management.visual.payload_rules.value_default');
    }
  };

  const getParamErrorMessage = (param: PayloadParamEntry) => {
    const errorCode = getPayloadParamValidationError(
      rawJsonValues ? { ...param, valueType: 'json' } : param
    );
    return getValidationMessage(t, errorCode);
  };

  const renderConditionValueEditor = (
    ruleIndex: number,
    modelIndex: number,
    key: 'match' | 'notMatch',
    conditionIndex: number,
    condition: PayloadParamEntry
  ) => {
    if (condition.valueType === 'boolean') {
      return (
        <Select
          value={
            condition.value.toLowerCase() === 'true' || condition.value.toLowerCase() === 'false'
              ? condition.value.toLowerCase()
              : ''
          }
          options={booleanValueOptions}
          placeholder={t('config_management.visual.payload_rules.value_boolean')}
          disabled={disabled}
          ariaLabel={t('config_management.visual.payload_rules.condition_value')}
          onChange={(nextValue) =>
            updateCondition(ruleIndex, modelIndex, key, conditionIndex, { value: nextValue })
          }
        />
      );
    }

    if (condition.valueType === 'json') {
      return (
        <textarea
          className={`input ${styles.payloadJsonInput}`}
          placeholder={getValuePlaceholder(condition.valueType)}
          aria-label={t('config_management.visual.payload_rules.condition_value')}
          value={condition.value}
          onChange={(e) =>
            updateCondition(ruleIndex, modelIndex, key, conditionIndex, {
              value: e.target.value,
            })
          }
          disabled={disabled}
        />
      );
    }

    return (
      <ExpandableInput
        placeholder={getValuePlaceholder(condition.valueType)}
        ariaLabel={t('config_management.visual.payload_rules.condition_value')}
        value={condition.value}
        onChange={(nextValue) =>
          updateCondition(ruleIndex, modelIndex, key, conditionIndex, { value: nextValue })
        }
        disabled={disabled}
      />
    );
  };

  const renderParamValueEditor = (
    ruleIndex: number,
    paramIndex: number,
    param: PayloadParamEntry
  ) => {
    if (rawJsonValues) {
      return (
        <textarea
          className={`input ${styles.payloadJsonInput}`}
          placeholder={t('config_management.visual.payload_rules.value_raw_json')}
          aria-label={t('config_management.visual.payload_rules.param_value')}
          value={param.value}
          onChange={(e) =>
            updateParam(ruleIndex, paramIndex, { value: e.target.value, valueType: 'json' })
          }
          disabled={disabled}
        />
      );
    }

    if (param.valueType === 'boolean') {
      return (
        <Select
          value={
            param.value.toLowerCase() === 'true' || param.value.toLowerCase() === 'false'
              ? param.value.toLowerCase()
              : ''
          }
          options={booleanValueOptions}
          placeholder={t('config_management.visual.payload_rules.value_boolean')}
          disabled={disabled}
          ariaLabel={t('config_management.visual.payload_rules.param_value')}
          onChange={(nextValue) => updateParam(ruleIndex, paramIndex, { value: nextValue })}
        />
      );
    }

    if (param.valueType === 'json') {
      return (
        <textarea
          className={`input ${styles.payloadJsonInput}`}
          placeholder={getValuePlaceholder(param.valueType)}
          aria-label={t('config_management.visual.payload_rules.param_value')}
          value={param.value}
          onChange={(e) => updateParam(ruleIndex, paramIndex, { value: e.target.value })}
          disabled={disabled}
        />
      );
    }

    return (
      <ExpandableInput
        placeholder={getValuePlaceholder(param.valueType)}
        ariaLabel={t('config_management.visual.payload_rules.param_value')}
        value={param.value}
        onChange={(nextValue) => updateParam(ruleIndex, paramIndex, { value: nextValue })}
        disabled={disabled}
      />
    );
  };

  return (
    <div className={styles.blockStack}>
      {rules.map((rule, ruleIndex) => (
        <div key={rule.id} className={styles.ruleCard}>
          <div className={styles.ruleCardHeader}>
            <div className={styles.ruleCardTitle}>
              {t('config_management.visual.payload_rules.rule')} {ruleIndex + 1}
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => removeRule(ruleIndex)}
              disabled={disabled}
            >
              {t('config_management.visual.common.delete')}
            </Button>
          </div>

          <div className={styles.blockStack}>
            <div className={styles.blockLabel}>
              {t('config_management.visual.payload_rules.models')}
            </div>
            {(rule.models.length ? rule.models : []).map((model, modelIndex) => {
              const hasAdvancedSettings = hasPayloadModelAdvancedSettings(model);
              const advancedExpanded = modelAdvancedOverrides[model.id] ?? hasAdvancedSettings;

              return (
                <div key={model.id} className={styles.payloadModelGroup}>
                  <div
                    className={[
                      styles.payloadRuleModelRow,
                      protocolFirst ? styles.payloadRuleModelRowProtocolFirst : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                  >
                    {protocolFirst ? (
                      <>
                        <Select
                          value={model.protocol ?? ''}
                          options={protocolOptions}
                          disabled={disabled}
                          ariaLabel={t('config_management.visual.payload_rules.provider_type')}
                          onChange={(nextValue) =>
                            updateModel(ruleIndex, modelIndex, {
                              protocol: (nextValue || undefined) as PayloadModelEntry['protocol'],
                            })
                          }
                        />
                        <ExpandableInput
                          placeholder={t('config_management.visual.payload_rules.model_name')}
                          ariaLabel={t('config_management.visual.payload_rules.model_name')}
                          value={model.name}
                          onChange={(nextValue) =>
                            updateModel(ruleIndex, modelIndex, { name: nextValue })
                          }
                          disabled={disabled}
                        />
                      </>
                    ) : (
                      <>
                        <ExpandableInput
                          placeholder={t('config_management.visual.payload_rules.model_name')}
                          ariaLabel={t('config_management.visual.payload_rules.model_name')}
                          value={model.name}
                          onChange={(nextValue) =>
                            updateModel(ruleIndex, modelIndex, { name: nextValue })
                          }
                          disabled={disabled}
                        />
                        <Select
                          value={model.protocol ?? ''}
                          options={protocolOptions}
                          disabled={disabled}
                          ariaLabel={t('config_management.visual.payload_rules.provider_type')}
                          onChange={(nextValue) =>
                            updateModel(ruleIndex, modelIndex, {
                              protocol: (nextValue || undefined) as PayloadModelEntry['protocol'],
                            })
                          }
                        />
                      </>
                    )}
                    <Button
                      variant="secondary"
                      size="sm"
                      className={styles.payloadRowActionButton}
                      onClick={() => toggleModelAdvanced(model.id, hasAdvancedSettings)}
                      disabled={disabled}
                    >
                      {advancedExpanded
                        ? t('config_management.visual.payload_rules.hide_advanced')
                        : t('config_management.visual.payload_rules.advanced')}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className={styles.payloadRowActionButton}
                      onClick={() => removeModel(ruleIndex, modelIndex)}
                      disabled={disabled}
                    >
                      {t('config_management.visual.common.delete')}
                    </Button>
                  </div>

                  {advancedExpanded ? (
                    <div className={styles.payloadModelAdvanced}>
                      <div className={styles.payloadAdvancedGrid}>
                        <div className={styles.fieldShell}>
                          <label className={styles.fieldLabel}>
                            {t('config_management.visual.payload_rules.from_protocol')}
                          </label>
                          <Select
                            value={model.fromProtocol ?? ''}
                            options={fromProtocolOptions}
                            disabled={disabled}
                            ariaLabel={t('config_management.visual.payload_rules.from_protocol')}
                            onChange={(nextValue) =>
                              updateModel(ruleIndex, modelIndex, {
                                fromProtocol: (nextValue ||
                                  undefined) as PayloadModelEntry['fromProtocol'],
                              })
                            }
                          />
                        </div>
                      </div>

                      <div className={styles.blockStack}>
                        <div className={styles.blockLabel}>
                          {t('config_management.visual.payload_rules.headers')}
                        </div>
                        {(model.headers ?? []).map((header, headerIndex) => (
                          <div key={header.id} className={styles.payloadHeaderRow}>
                            <ExpandableInput
                              placeholder={t('config_management.visual.payload_rules.header_name')}
                              ariaLabel={t('config_management.visual.payload_rules.header_name')}
                              value={header.name}
                              onChange={(nextValue) =>
                                updateHeader(ruleIndex, modelIndex, headerIndex, {
                                  name: nextValue,
                                })
                              }
                              disabled={disabled}
                            />
                            <ExpandableInput
                              placeholder={t('config_management.visual.payload_rules.header_value')}
                              ariaLabel={t('config_management.visual.payload_rules.header_value')}
                              value={header.value}
                              onChange={(nextValue) =>
                                updateHeader(ruleIndex, modelIndex, headerIndex, {
                                  value: nextValue,
                                })
                              }
                              disabled={disabled}
                            />
                            <Button
                              variant="ghost"
                              size="sm"
                              className={styles.payloadRowActionButton}
                              onClick={() => removeHeader(ruleIndex, modelIndex, headerIndex)}
                              disabled={disabled}
                            >
                              {t('config_management.visual.common.delete')}
                            </Button>
                          </div>
                        ))}
                        <div className={styles.actionRow}>
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => addHeader(ruleIndex, modelIndex)}
                            disabled={disabled}
                          >
                            {t('config_management.visual.payload_rules.add_header')}
                          </Button>
                        </div>
                      </div>

                      {(['match', 'notMatch'] as const).map((conditionKey) => (
                        <div key={conditionKey} className={styles.blockStack}>
                          <div className={styles.blockLabel}>
                            {t(`config_management.visual.payload_rules.${conditionKey}`)}
                          </div>
                          {(model[conditionKey] ?? []).map((condition, conditionIndex) => {
                            const conditionError = getValidationMessage(
                              t,
                              getPayloadParamValidationError(condition)
                            );

                            return (
                              <div key={condition.id} className={styles.payloadRuleParamGroup}>
                                <div className={styles.payloadRuleParamRow}>
                                  <ExpandableInput
                                    placeholder={t(
                                      'config_management.visual.payload_rules.condition_path'
                                    )}
                                    ariaLabel={t(
                                      'config_management.visual.payload_rules.condition_path'
                                    )}
                                    value={condition.path}
                                    onChange={(nextValue) =>
                                      updateCondition(
                                        ruleIndex,
                                        modelIndex,
                                        conditionKey,
                                        conditionIndex,
                                        { path: nextValue }
                                      )
                                    }
                                    disabled={disabled}
                                  />
                                  <Select
                                    value={condition.valueType}
                                    options={payloadValueTypeOptions}
                                    disabled={disabled}
                                    ariaLabel={t(
                                      'config_management.visual.payload_rules.param_type'
                                    )}
                                    onChange={(nextValue) =>
                                      updateCondition(
                                        ruleIndex,
                                        modelIndex,
                                        conditionKey,
                                        conditionIndex,
                                        {
                                          valueType: nextValue as PayloadParamValueType,
                                          value:
                                            nextValue === 'boolean'
                                              ? 'true'
                                              : nextValue === 'json' &&
                                                  condition.value.trim() === ''
                                                ? '{}'
                                                : condition.value,
                                        }
                                      )
                                    }
                                  />
                                  {renderConditionValueEditor(
                                    ruleIndex,
                                    modelIndex,
                                    conditionKey,
                                    conditionIndex,
                                    condition
                                  )}
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className={styles.payloadRowActionButton}
                                    onClick={() =>
                                      removeCondition(
                                        ruleIndex,
                                        modelIndex,
                                        conditionKey,
                                        conditionIndex
                                      )
                                    }
                                    disabled={disabled}
                                  >
                                    {t('config_management.visual.common.delete')}
                                  </Button>
                                </div>
                                {conditionError ? (
                                  <div className={`error-box ${styles.payloadParamError}`}>
                                    {conditionError}
                                  </div>
                                ) : null}
                              </div>
                            );
                          })}
                          <div className={styles.actionRow}>
                            <Button
                              variant="secondary"
                              size="sm"
                              onClick={() => addCondition(ruleIndex, modelIndex, conditionKey)}
                              disabled={disabled}
                            >
                              {t('config_management.visual.payload_rules.add_condition')}
                            </Button>
                          </div>
                        </div>
                      ))}

                      <div className={styles.payloadAdvancedGrid}>
                        <div className={styles.blockStack}>
                          <div className={styles.blockLabel}>
                            {t('config_management.visual.payload_rules.exist')}
                          </div>
                          <StringListEditor
                            value={model.exist ?? []}
                            disabled={disabled}
                            placeholder={t('config_management.visual.payload_rules.condition_path')}
                            inputAriaLabel={t(
                              'config_management.visual.payload_rules.condition_path'
                            )}
                            onChange={(exist) => updateModel(ruleIndex, modelIndex, { exist })}
                          />
                        </div>
                        <div className={styles.blockStack}>
                          <div className={styles.blockLabel}>
                            {t('config_management.visual.payload_rules.notExist')}
                          </div>
                          <StringListEditor
                            value={model.notExist ?? []}
                            disabled={disabled}
                            placeholder={t('config_management.visual.payload_rules.condition_path')}
                            inputAriaLabel={t(
                              'config_management.visual.payload_rules.condition_path'
                            )}
                            onChange={(notExist) =>
                              updateModel(ruleIndex, modelIndex, { notExist })
                            }
                          />
                        </div>
                      </div>
                    </div>
                  ) : null}
                </div>
              );
            })}
            <div className={styles.actionRow}>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => addModel(ruleIndex)}
                disabled={disabled}
              >
                {t('config_management.visual.payload_rules.add_model')}
              </Button>
            </div>
          </div>

          <div className={styles.blockStack}>
            <div className={styles.blockLabel}>
              {t('config_management.visual.payload_rules.params')}
            </div>
            {(rule.params.length ? rule.params : []).map((param, paramIndex) => {
              const paramError = getParamErrorMessage(param);

              return (
                <div key={param.id} className={styles.payloadRuleParamGroup}>
                  <div className={styles.payloadRuleParamRow}>
                    <ExpandableInput
                      placeholder={t('config_management.visual.payload_rules.json_path')}
                      ariaLabel={t('config_management.visual.payload_rules.json_path')}
                      value={param.path}
                      onChange={(nextValue) =>
                        updateParam(ruleIndex, paramIndex, { path: nextValue })
                      }
                      disabled={disabled}
                    />
                    {rawJsonValues ? null : (
                      <Select
                        value={param.valueType}
                        options={payloadValueTypeOptions}
                        disabled={disabled}
                        ariaLabel={t('config_management.visual.payload_rules.param_type')}
                        onChange={(nextValue) =>
                          updateParam(ruleIndex, paramIndex, {
                            valueType: nextValue as PayloadParamValueType,
                            value:
                              nextValue === 'boolean'
                                ? 'true'
                                : nextValue === 'json' && param.value.trim() === ''
                                  ? '{}'
                                  : param.value,
                          })
                        }
                      />
                    )}
                    {renderParamValueEditor(ruleIndex, paramIndex, param)}
                    <Button
                      variant="ghost"
                      size="sm"
                      className={styles.payloadRowActionButton}
                      onClick={() => removeParam(ruleIndex, paramIndex)}
                      disabled={disabled}
                    >
                      {t('config_management.visual.common.delete')}
                    </Button>
                  </div>
                  {paramError && (
                    <div className={`error-box ${styles.payloadParamError}`}>{paramError}</div>
                  )}
                </div>
              );
            })}
            <div className={styles.actionRow}>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => addParam(ruleIndex)}
                disabled={disabled}
              >
                {t('config_management.visual.payload_rules.add_param')}
              </Button>
            </div>
          </div>
        </div>
      ))}

      {rules.length === 0 && (
        <div className={styles.emptyState}>
          {t('config_management.visual.payload_rules.no_rules')}
        </div>
      )}

      <div className={styles.actionRow}>
        <Button variant="secondary" size="sm" onClick={addRule} disabled={disabled}>
          {t('config_management.visual.payload_rules.add_rule')}
        </Button>
      </div>
    </div>
  );
});

export const PayloadFilterRulesEditor = memo(function PayloadFilterRulesEditor({
  value,
  disabled,
  onChange,
}: {
  value: PayloadFilterRule[];
  disabled?: boolean;
  onChange: (next: PayloadFilterRule[]) => void;
}) {
  const { t } = useTranslation();
  const rules = value;
  const protocolOptions = useMemo(() => buildProtocolOptions(t, rules), [rules, t]);

  const addRule = () => onChange([...rules, { id: makeClientId(), models: [], params: [] }]);
  const removeRule = (ruleIndex: number) => onChange(rules.filter((_, i) => i !== ruleIndex));

  const updateRule = (ruleIndex: number, patch: Partial<PayloadFilterRule>) =>
    onChange(rules.map((rule, i) => (i === ruleIndex ? { ...rule, ...patch } : rule)));

  const addModel = (ruleIndex: number) => {
    const rule = rules[ruleIndex];
    const nextModel: PayloadModelEntry = { id: makeClientId(), name: '', protocol: undefined };
    updateRule(ruleIndex, { models: [...rule.models, nextModel] });
  };

  const removeModel = (ruleIndex: number, modelIndex: number) => {
    const rule = rules[ruleIndex];
    updateRule(ruleIndex, { models: rule.models.filter((_, i) => i !== modelIndex) });
  };

  const updateModel = (
    ruleIndex: number,
    modelIndex: number,
    patch: Partial<PayloadModelEntry>
  ) => {
    const rule = rules[ruleIndex];
    updateRule(ruleIndex, {
      models: rule.models.map((m, i) => (i === modelIndex ? { ...m, ...patch } : m)),
    });
  };

  return (
    <div className={styles.blockStack}>
      {rules.map((rule, ruleIndex) => (
        <div key={rule.id} className={styles.ruleCard}>
          <div className={styles.ruleCardHeader}>
            <div className={styles.ruleCardTitle}>
              {t('config_management.visual.payload_rules.rule')} {ruleIndex + 1}
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => removeRule(ruleIndex)}
              disabled={disabled}
            >
              {t('config_management.visual.common.delete')}
            </Button>
          </div>

          <div className={styles.blockStack}>
            <div className={styles.blockLabel}>
              {t('config_management.visual.payload_rules.models')}
            </div>
            {rule.models.map((model, modelIndex) => (
              <div key={model.id} className={styles.payloadFilterModelRow}>
                <ExpandableInput
                  placeholder={t('config_management.visual.payload_rules.model_name')}
                  ariaLabel={t('config_management.visual.payload_rules.model_name')}
                  value={model.name}
                  onChange={(nextValue) => updateModel(ruleIndex, modelIndex, { name: nextValue })}
                  disabled={disabled}
                />
                <Select
                  value={model.protocol ?? ''}
                  options={protocolOptions}
                  disabled={disabled}
                  ariaLabel={t('config_management.visual.payload_rules.provider_type')}
                  onChange={(nextValue) =>
                    updateModel(ruleIndex, modelIndex, {
                      protocol: (nextValue || undefined) as PayloadModelEntry['protocol'],
                    })
                  }
                />
                <Button
                  variant="ghost"
                  size="sm"
                  className={styles.payloadRowActionButton}
                  onClick={() => removeModel(ruleIndex, modelIndex)}
                  disabled={disabled}
                >
                  {t('config_management.visual.common.delete')}
                </Button>
              </div>
            ))}
            <div className={styles.actionRow}>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => addModel(ruleIndex)}
                disabled={disabled}
              >
                {t('config_management.visual.payload_rules.add_model')}
              </Button>
            </div>
          </div>

          <div className={styles.blockStack}>
            <div className={styles.blockLabel}>
              {t('config_management.visual.payload_rules.remove_params')}
            </div>
            <StringListEditor
              value={rule.params}
              disabled={disabled}
              placeholder={t('config_management.visual.payload_rules.json_path_filter')}
              inputAriaLabel={t('config_management.visual.payload_rules.json_path_filter')}
              onChange={(params) => updateRule(ruleIndex, { params })}
            />
          </div>
        </div>
      ))}

      {rules.length === 0 && (
        <div className={styles.emptyState}>
          {t('config_management.visual.payload_rules.no_rules')}
        </div>
      )}

      <div className={styles.actionRow}>
        <Button variant="secondary" size="sm" onClick={addRule} disabled={disabled}>
          {t('config_management.visual.payload_rules.add_rule')}
        </Button>
      </div>
    </div>
  );
});
