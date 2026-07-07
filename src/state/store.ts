// Reactive config store with localStorage persistence and JSON import/export.
// Replaces the settings.json save/load/reset flow from the original app.

import { useSyncExternalStore } from 'react';
import { Config, defaultConfig } from './config';

const STORAGE_KEY = 'peptidome.config.v1';

let current: Config = loadFromStorage();
const listeners = new Set<() => void>();

function loadFromStorage(): Config {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return mergeWithDefaults(JSON.parse(raw));
  } catch {
    /* ignore corrupt storage */
  }
  return defaultConfig();
}

/** Saved settings override defaults; unknown keys are dropped, missing keys filled. */
export function mergeWithDefaults(partial: Partial<Config>): Config {
  const base = defaultConfig();
  return {
    ...base,
    ...partial,
    fontSizes: { ...base.fontSizes, ...(partial.fontSizes ?? {}) },
    page: { ...base.page, ...(partial.page ?? {}) },
    timeLabels: { ...(partial.timeLabels ?? {}) },
    modifications: { ...(partial.modifications ?? {}) },
  };
}

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
  } catch {
    /* storage may be full or unavailable; non-fatal */
  }
}

function emit() {
  persist();
  listeners.forEach((l) => l());
}

export function getConfig(): Config {
  return current;
}

/** Apply a partial update (shallow merge) and notify subscribers. */
export function setConfig(patch: Partial<Config> | ((c: Config) => Partial<Config>)): void {
  const delta = typeof patch === 'function' ? patch(current) : patch;
  current = { ...current, ...delta };
  emit();
}

/** Replace the whole config (used by import). */
export function replaceConfig(next: Config): void {
  current = mergeWithDefaults(next);
  emit();
}

export function resetConfig(): void {
  current = defaultConfig();
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** React hook: re-renders the component whenever the config changes. */
export function useConfig(): Config {
  return useSyncExternalStore(subscribe, getConfig, getConfig);
}

/** Export current config as a pretty JSON string. */
export function exportConfigJson(): string {
  return JSON.stringify(current, null, 2);
}

/** Import config from a JSON string; returns true on success. */
export function importConfigJson(json: string): boolean {
  try {
    replaceConfig(JSON.parse(json));
    return true;
  } catch {
    return false;
  }
}
