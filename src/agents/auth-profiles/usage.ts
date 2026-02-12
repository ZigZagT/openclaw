import type { OpenClawConfig } from "../../config/config.js";
import type {
  AuthProfileFailureReason,
  AuthProfileStore,
  ProfileUsageStats,
  ModelUsageStats,
} from "./types.js";
import { normalizeProviderId } from "../model-selection.js";
import { saveAuthProfileStore, updateAuthProfileStoreWithLock } from "./store.js";

function resolveProfileUnusableUntil(stats: ProfileUsageStats, modelId?: string): number | null {
  const values = [stats.cooldownUntil, stats.disabledUntil]
    .filter((value): value is number => typeof value === "number")
    .filter((value) => Number.isFinite(value) && value > 0);

  if (modelId && stats.modelStats?.[modelId]?.cooldownUntil) {
    values.push(stats.modelStats[modelId].cooldownUntil);
  }

  if (values.length === 0) {
    return null;
  }
  return Math.max(...values);
}

/**
 * Check if a profile is currently in cooldown (due to rate limiting or errors).
 */
export function isProfileInCooldown(
  store: AuthProfileStore,
  profileId: string,
  modelId?: string,
): boolean {
  const stats = store.usageStats?.[profileId];
  if (!stats) {
    return false;
  }
  const unusableUntil = resolveProfileUnusableUntil(stats, modelId);
  return unusableUntil ? Date.now() < unusableUntil : false;
}

/**
 * Mark a profile as successfully used. Resets error count and updates lastUsed.
 * Uses store lock to avoid overwriting concurrent usage updates.
 */
export async function markAuthProfileUsed(params: {
  store: AuthProfileStore;
  profileId: string;
  modelId?: string;
  agentDir?: string;
}): Promise<void> {
  const { store, profileId, modelId, agentDir } = params;
  const updated = await updateAuthProfileStoreWithLock({
    agentDir,
    updater: (freshStore) => {
      if (!freshStore.profiles[profileId]) {
        return false;
      }
      freshStore.usageStats = freshStore.usageStats ?? {};
      const existing = freshStore.usageStats[profileId] ?? {};

      const newStats: ProfileUsageStats = {
        ...existing,
        lastUsed: Date.now(),
        errorCount: 0,
        cooldownUntil: undefined,
        disabledUntil: undefined,
        disabledReason: undefined,
        failureCounts: undefined,
      };

      if (modelId) {
        newStats.modelStats = newStats.modelStats ?? {};
        newStats.modelStats[modelId] = {
          lastUsed: Date.now(),
          errorCount: 0,
          cooldownUntil: undefined,
        };
      }

      freshStore.usageStats[profileId] = newStats;
      return true;
    },
  });
  if (updated) {
    store.usageStats = updated.usageStats;
    return;
  }
  if (!store.profiles[profileId]) {
    return;
  }

  store.usageStats = store.usageStats ?? {};
  const existing = store.usageStats[profileId] ?? {};
  const newStats: ProfileUsageStats = {
    ...existing,
    lastUsed: Date.now(),
    errorCount: 0,
    cooldownUntil: undefined,
    disabledUntil: undefined,
    disabledReason: undefined,
    failureCounts: undefined,
  };

  if (modelId) {
    newStats.modelStats = newStats.modelStats ?? {};
    newStats.modelStats[modelId] = {
      lastUsed: Date.now(),
      errorCount: 0,
      cooldownUntil: undefined,
    };
  }
  store.usageStats[profileId] = newStats;
  saveAuthProfileStore(store, agentDir);
}

export function calculateAuthProfileCooldownMs(errorCount: number): number {
  const normalized = Math.max(1, errorCount);
  return Math.min(
    60 * 60 * 1000, // 1 hour max
    60 * 1000 * 5 ** Math.min(normalized - 1, 3),
  );
}

type ResolvedAuthCooldownConfig = {
  billingBackoffMs: number;
  billingMaxMs: number;
  failureWindowMs: number;
};

function resolveAuthCooldownConfig(params: {
  cfg?: OpenClawConfig;
  providerId: string;
}): ResolvedAuthCooldownConfig {
  const defaults = {
    billingBackoffHours: 5,
    billingMaxHours: 24,
    failureWindowHours: 24,
  } as const;

  const resolveHours = (value: unknown, fallback: number) =>
    typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;

  const cooldowns = params.cfg?.auth?.cooldowns;
  const billingOverride = (() => {
    const map = cooldowns?.billingBackoffHoursByProvider;
    if (!map) {
      return undefined;
    }
    for (const [key, value] of Object.entries(map)) {
      if (normalizeProviderId(key) === params.providerId) {
        return value;
      }
    }
    return undefined;
  })();

  const billingBackoffHours = resolveHours(
    billingOverride ?? cooldowns?.billingBackoffHours,
    defaults.billingBackoffHours,
  );
  const billingMaxHours = resolveHours(cooldowns?.billingMaxHours, defaults.billingMaxHours);
  const failureWindowHours = resolveHours(
    cooldowns?.failureWindowHours,
    defaults.failureWindowHours,
  );

  return {
    billingBackoffMs: billingBackoffHours * 60 * 60 * 1000,
    billingMaxMs: billingMaxHours * 60 * 60 * 1000,
    failureWindowMs: failureWindowHours * 60 * 60 * 1000,
  };
}

function calculateAuthProfileBillingDisableMsWithConfig(params: {
  errorCount: number;
  baseMs: number;
  maxMs: number;
}): number {
  const normalized = Math.max(1, params.errorCount);
  const baseMs = Math.max(60_000, params.baseMs);
  const maxMs = Math.max(baseMs, params.maxMs);
  const exponent = Math.min(normalized - 1, 10);
  const raw = baseMs * 2 ** exponent;
  return Math.min(maxMs, raw);
}

export function resolveProfileUnusableUntilForDisplay(
  store: AuthProfileStore,
  profileId: string,
  modelId?: string,
): number | null {
  const stats = store.usageStats?.[profileId];
  if (!stats) {
    return null;
  }
  return resolveProfileUnusableUntil(stats, modelId);
}

function computeNextProfileUsageStats(params: {
  existing: ProfileUsageStats;
  now: number;
  reason: AuthProfileFailureReason;
  cfgResolved: ResolvedAuthCooldownConfig;
  modelId?: string;
  retryAfterMs?: number;
}): ProfileUsageStats {
  const windowMs = params.cfgResolved.failureWindowMs;
  const windowExpired =
    typeof params.existing.lastFailureAt === "number" &&
    params.existing.lastFailureAt > 0 &&
    params.now - params.existing.lastFailureAt > windowMs;

  const updatedStats: ProfileUsageStats = { ...params.existing };

  // Billing failure is always profile-wide
  if (params.reason === "billing") {
    const failureCounts = windowExpired ? {} : { ...params.existing.failureCounts };
    failureCounts[params.reason] = (failureCounts[params.reason] ?? 0) + 1;
    const billingCount = failureCounts.billing ?? 1;

    const backoffMs = calculateAuthProfileBillingDisableMsWithConfig({
      errorCount: billingCount,
      baseMs: params.cfgResolved.billingBackoffMs,
      maxMs: params.cfgResolved.billingMaxMs,
    });

    updatedStats.disabledUntil = params.now + backoffMs;
    updatedStats.disabledReason = "billing";
    updatedStats.failureCounts = failureCounts;
    updatedStats.lastFailureAt = params.now;
    return updatedStats;
  }

  // Handle per-model vs profile-wide cooldowns
  const isModelSpecific =
    !!params.modelId && (params.reason === "rate_limit" || params.reason === "timeout");

  if (isModelSpecific && params.modelId) {
    // Model-specific cooldown
    updatedStats.modelStats = updatedStats.modelStats ?? {};
    const modelStats = updatedStats.modelStats[params.modelId] ?? {};
    const modelErrorCount = (modelStats.errorCount ?? 0) + 1;

    const backoffMs = params.retryAfterMs ?? calculateAuthProfileCooldownMs(modelErrorCount);

    updatedStats.modelStats[params.modelId] = {
      ...modelStats,
      errorCount: modelErrorCount,
      cooldownUntil: params.now + backoffMs,
      lastFailureAt: params.now,
    };
  } else {
    // Fallback to profile-wide cooldown
    const baseErrorCount = windowExpired ? 0 : (params.existing.errorCount ?? 0);
    const nextErrorCount = baseErrorCount + 1;

    const backoffMs = params.retryAfterMs ?? calculateAuthProfileCooldownMs(nextErrorCount);

    updatedStats.errorCount = nextErrorCount;
    updatedStats.cooldownUntil = params.now + backoffMs;
    updatedStats.lastFailureAt = params.now;
  }

  return updatedStats;
}

/**
 * Mark a profile as failed for a specific reason. Billing failures are treated
 * as "disabled" (longer backoff) vs the regular cooldown window.
 */
export async function markAuthProfileFailure(params: {
  store: AuthProfileStore;
  profileId: string;
  reason: AuthProfileFailureReason;
  cfg?: OpenClawConfig;
  agentDir?: string;
  modelId?: string;
  retryAfterMs?: number;
}): Promise<void> {
  const { store, profileId, reason, agentDir, cfg, modelId, retryAfterMs } = params;
  const updated = await updateAuthProfileStoreWithLock({
    agentDir,
    updater: (freshStore) => {
      const profile = freshStore.profiles[profileId];
      if (!profile) {
        return false;
      }
      freshStore.usageStats = freshStore.usageStats ?? {};
      const existing = freshStore.usageStats[profileId] ?? {};

      const now = Date.now();
      const providerKey = normalizeProviderId(profile.provider);
      const cfgResolved = resolveAuthCooldownConfig({
        cfg,
        providerId: providerKey,
      });

      freshStore.usageStats[profileId] = computeNextProfileUsageStats({
        existing,
        now,
        reason,
        cfgResolved,
        modelId,
        retryAfterMs,
      });
      return true;
    },
  });
  if (updated) {
    store.usageStats = updated.usageStats;
    return;
  }
  if (!store.profiles[profileId]) {
    return;
  }

  store.usageStats = store.usageStats ?? {};
  const existing = store.usageStats[profileId] ?? {};
  const now = Date.now();
  const providerKey = normalizeProviderId(store.profiles[profileId]?.provider ?? "");
  const cfgResolved = resolveAuthCooldownConfig({
    cfg,
    providerId: providerKey,
  });

  store.usageStats[profileId] = computeNextProfileUsageStats({
    existing,
    now,
    reason,
    cfgResolved,
    modelId,
    retryAfterMs,
  });
  saveAuthProfileStore(store, agentDir);
}

/**
 * Mark a profile as failed/rate-limited. Applies exponential backoff cooldown.
 * Cooldown times: 1min, 5min, 25min, max 1 hour.
 * Uses store lock to avoid overwriting concurrent usage updates.
 */
export async function markAuthProfileCooldown(params: {
  store: AuthProfileStore;
  profileId: string;
  agentDir?: string;
  modelId?: string;
  retryAfterMs?: number;
}): Promise<void> {
  await markAuthProfileFailure({
    store: params.store,
    profileId: params.profileId,
    reason: "rate_limit",
    agentDir: params.agentDir,
    modelId: params.modelId,
    retryAfterMs: params.retryAfterMs,
  });
}

/**
 * Clear cooldown for a profile (e.g., manual reset).
 * Uses store lock to avoid overwriting concurrent usage updates.
 */
export async function clearAuthProfileCooldown(params: {
  store: AuthProfileStore;
  profileId: string;
  agentDir?: string;
  modelId?: string;
}): Promise<void> {
  const { store, profileId, agentDir, modelId } = params;
  const updated = await updateAuthProfileStoreWithLock({
    agentDir,
    updater: (freshStore) => {
      if (!freshStore.usageStats?.[profileId]) {
        return false;
      }

      const stats = freshStore.usageStats[profileId];
      if (modelId) {
        if (stats.modelStats?.[modelId]) {
          stats.modelStats[modelId] = {
            ...stats.modelStats[modelId],
            errorCount: 0,
            cooldownUntil: undefined,
          };
        }
      } else {
        // Clear global profile cooldown
        freshStore.usageStats[profileId] = {
          ...stats,
          errorCount: 0,
          cooldownUntil: undefined,
        };
      }
      return true;
    },
  });
  if (updated) {
    store.usageStats = updated.usageStats;
    return;
  }
  if (!store.usageStats?.[profileId]) {
    return;
  }

  const stats = store.usageStats[profileId];
  if (modelId) {
    if (stats.modelStats?.[modelId]) {
      stats.modelStats[modelId] = {
        ...stats.modelStats[modelId],
        errorCount: 0,
        cooldownUntil: undefined,
      };
    }
  } else {
    store.usageStats[profileId] = {
      ...stats,
      errorCount: 0,
      cooldownUntil: undefined,
    };
  }
  saveAuthProfileStore(store, agentDir);
}
