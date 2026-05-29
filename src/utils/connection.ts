import { DEFAULT_API_PORT, MANAGEMENT_API_PREFIX } from './constants';

export const DEFAULT_DOCKER_CPA_BASE_URL = 'http://host.docker.internal:8317';

export const normalizeApiBase = (input: string): string => {
  let base = (input || '').trim();
  if (!base) return '';
  base = base.replace(/\/?v0\/management\/?$/i, '');
  base = base.replace(/\/+$/i, '');
  if (!/^https?:\/\//i.test(base)) {
    base = `http://${base}`;
  }
  return base;
};

export const computeApiUrl = (base: string): string => {
  const normalized = normalizeApiBase(base);
  if (!normalized) return '';
  return `${normalized}${MANAGEMENT_API_PREFIX}`;
};

const readEnvDefaultCPAConnectionBase = (): string => {
  try {
    return import.meta.env.VITE_DEFAULT_CPA_BASE_URL || '';
  } catch {
    return '';
  }
};

export const resolveDefaultCPAConnectionBase = (options?: {
  hostedByUsageService?: boolean;
  currentBase?: string;
  envDefault?: string;
}): string => {
  const envDefault = normalizeApiBase(
    options?.envDefault === undefined ? readEnvDefaultCPAConnectionBase() : options.envDefault
  );
  if (envDefault) return envDefault;

  if (options?.hostedByUsageService) {
    return DEFAULT_DOCKER_CPA_BASE_URL;
  }

  const currentBase = normalizeApiBase(options?.currentBase || '');
  try {
    if (import.meta.env.DEV && currentBase) {
      const parsed = new URL(currentBase);
      if (isLocalhost(parsed.hostname) && parsed.port && parsed.port !== String(DEFAULT_API_PORT)) {
        return normalizeApiBase(`${parsed.protocol}//${parsed.hostname}:${DEFAULT_API_PORT}`);
      }
    }
  } catch {
    return currentBase;
  }

  return currentBase;
};

export const isDevFrontendBase = (base: string): boolean => {
  if (!import.meta.env.DEV) return false;
  const normalized = normalizeApiBase(base);
  if (!normalized) return false;
  try {
    const parsed = new URL(normalized);
    return (
      isLocalhost(parsed.hostname) &&
      Boolean(parsed.port) &&
      parsed.port !== String(DEFAULT_API_PORT)
    );
  } catch {
    return false;
  }
};

export const detectApiBaseFromLocation = (): string => {
  try {
    const { protocol, hostname, port } = window.location;
    const normalizedPort = port ? `:${port}` : '';
    return normalizeApiBase(`${protocol}//${hostname}${normalizedPort}`);
  } catch (error) {
    console.warn('Failed to detect api base from location, fallback to default', error);
    return normalizeApiBase(`http://localhost:${DEFAULT_API_PORT}`);
  }
};

export const isLocalhost = (hostname: string): boolean => {
  const value = (hostname || '').toLowerCase();
  return value === 'localhost' || value === '127.0.0.1' || value === '[::1]';
};
