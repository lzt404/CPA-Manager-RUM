import { act, createElement, useEffect } from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import { useVisualConfig } from './useVisualConfig';

type UseVisualConfigHarness = {
  getCurrent: () => ReturnType<typeof useVisualConfig>;
  unmount: () => void;
};

const mountUseVisualConfig = (): UseVisualConfigHarness => {
  let hook: ReturnType<typeof useVisualConfig> | null = null;
  let renderer: ReactTestRenderer | null = null;

  function HookHarness() {
    const current = useVisualConfig();
    useEffect(() => {
      hook = current;
    });
    return null;
  }

  act(() => {
    renderer = create(createElement(HookHarness));
  });

  return {
    getCurrent: () => {
      if (!hook) {
        throw new Error('Failed to mount useVisualConfig test harness');
      }
      return hook;
    },
    unmount: () => {
      if (!renderer) return;
      act(() => {
        renderer?.unmount();
      });
    },
  };
};

describe('useVisualConfig API key access rules', () => {
  it('parses inline api key access rules and preserves deny-all entries', () => {
    const hook = mountUseVisualConfig();

    act(() => {
      hook.getCurrent().loadVisualValuesFromYaml(`
api-keys:
  - api-key: client-a
    allowed-auth-indexes:
      - idx-a
      - idx-b
  - api-key: client-b
    allowed-auth-ids:
      - auth-b
  - client-c
`);
    });

    expect(hook.getCurrent().visualValues.apiKeysText).toBe('client-a\nclient-b\nclient-c');
    expect(hook.getCurrent().visualValues.apiKeyAccessRules).toMatchObject([
      {
        apiKey: 'client-a',
        allowedAuthIndexesText: 'idx-a\nidx-b',
        allowedAuthIdsText: '',
      },
      {
        apiKey: 'client-b',
        allowedAuthIndexesText: '',
        allowedAuthIdsText: 'auth-b',
      },
      {
        apiKey: 'client-c',
        allowedAuthIndexesText: '',
        allowedAuthIdsText: '',
      },
    ]);

    hook.unmount();
  });

  it('serializes access rules inline and removes legacy api-key-access-rules', () => {
    const hook = mountUseVisualConfig();
    const source = `
api-keys:
  - client-a
  - client-b
api-key-access-rules:
  - api-key: client-a
    allowed-auth-indexes:
      - old-idx
`;

    act(() => {
      hook.getCurrent().loadVisualValuesFromYaml(source);
    });
    act(() => {
      hook.getCurrent().setVisualValues({
        apiKeyAccessRules: [
          {
            id: 'client-a-rule',
            apiKey: 'client-a',
            allowedAuthIndexesText: 'idx-a\nidx-b',
            allowedAuthIdsText: '',
          },
          {
            id: 'client-b-rule',
            apiKey: 'client-b',
            allowedAuthIndexesText: '',
            allowedAuthIdsText: '',
          },
        ],
      });
    });

    const output = hook.getCurrent().applyVisualChangesToYaml(source);
    const parsed = parseYaml(output) as {
      'api-keys': Array<Record<string, unknown>>;
      'api-key-access-rules'?: unknown;
    };

    expect(parsed['api-key-access-rules']).toBeUndefined();
    expect(parsed['api-keys']).toEqual([
      {
        'api-key': 'client-a',
        'allowed-auth-indexes': ['idx-a', 'idx-b'],
      },
      {
        'api-key': 'client-b',
      },
    ]);

    hook.unmount();
  });

  it('prefers inline camelCase rules over legacy rules and parses scalar lists', () => {
    const hook = mountUseVisualConfig();

    act(() => {
      hook.getCurrent().loadVisualValuesFromYaml(`
api-keys:
  - apiKey: client-a
    allowedAuthIndexes: "inline-a, inline-b, inline-a"
    allowedAuthIds: "auth-a, auth-b"
api-key-access-rules:
  - api-key: client-a
    allowed-auth-indexes:
      - legacy-a
`);
    });

    expect(hook.getCurrent().visualValues.apiKeyAccessRules).toMatchObject([
      {
        apiKey: 'client-a',
        allowedAuthIndexesText: 'inline-a\ninline-b',
        allowedAuthIdsText: 'auth-a\nauth-b',
      },
    ]);

    hook.unmount();
  });
});
