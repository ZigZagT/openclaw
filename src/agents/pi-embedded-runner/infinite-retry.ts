import type { AuthProfileStore } from "../auth-profiles/types.js";
import { isProfileInCooldown, resolveProfileUnusableUntilForDisplay } from "../auth-profiles.js";
import { FailoverError } from "../failover-error.js";
import { log } from "./logger.js";

/**
 * Calculate the minimum wait time before any profile becomes available.
 * Returns 0 if at least one profile is available now.
 */
function calculateMinimumWaitMs(params: {
  store: AuthProfileStore;
  profileCandidates: (string | undefined)[];
  modelId: string;
}): number {
  const { store, profileCandidates, modelId } = params;
  const now = Date.now();
  let minUnusableUntil: number | null = null;

  for (const profileId of profileCandidates) {
    if (!profileId) {
      continue;
    }

    if (!isProfileInCooldown(store, profileId, modelId)) {
      // At least one profile is available now
      return 0;
    }

    const unusableUntil = resolveProfileUnusableUntilForDisplay(store, profileId, modelId);
    if (unusableUntil && unusableUntil > now) {
      if (minUnusableUntil === null || unusableUntil < minUnusableUntil) {
        minUnusableUntil = unusableUntil;
      }
    }
  }

  if (minUnusableUntil === null) {
    // All profiles are available (this shouldn't happen if we got here)
    return 0;
  }

  return Math.max(0, minUnusableUntil - now);
}

/**
 * Wraps a function to retry indefinitely on quota exhaustion.
 * Sleeps for the minimum cooldown time before retrying.
 */
export async function withInfiniteRetry<T>(params: {
  execute: () => Promise<T>;
  onQuotaExhaustion?: (params: {
    provider: string;
    model: string;
    waitMs: number;
    attempt: number;
  }) => void;
  authStore?: AuthProfileStore;
  profileCandidates?: (string | undefined)[];
  modelId?: string;
  provider?: string;
  abortSignal?: AbortSignal;
}): Promise<T> {
  const {
    execute,
    onQuotaExhaustion,
    authStore,
    profileCandidates,
    modelId,
    provider,
    abortSignal,
  } = params;

  let attempt = 0;

  while (true) {
    attempt++;

    if (abortSignal?.aborted) {
      throw new Error("Task aborted by user");
    }

    try {
      return await execute();
    } catch (error) {
      if (abortSignal?.aborted) {
        throw error;
      }

      // Only retry on quota/rate-limit failures
      if (
        error instanceof FailoverError &&
        (error.failoverReason === "rate_limit" || error.failoverReason === "timeout")
      ) {
        const waitMs =
          authStore && profileCandidates && modelId
            ? calculateMinimumWaitMs({ store: authStore, profileCandidates, modelId })
            : 60 * 1000; // Default 1 min if we can't calculate

        const waitSec = Math.ceil(waitMs / 1000);

        if (onQuotaExhaustion) {
          onQuotaExhaustion({
            provider: provider ?? "unknown",
            model: modelId ?? "unknown",
            waitMs,
            attempt,
          });
        } else {
          log.warn(
            `Quota exhausted for ${provider}/${modelId}. Waiting ${waitSec}s before retry (attempt ${attempt})...`,
          );
        }

        // Sleep with abort signal check
        await sleepWithAbort(waitMs, abortSignal);

        // Loop continues to retry
        continue;
      }

      // Non-quota error, rethrow
      throw error;
    }
  }
}

async function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Task aborted"));
      return;
    }

    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    const abortHandler = () => {
      cleanup();
      reject(new Error("Task aborted during cooldown wait"));
    };

    const cleanup = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abortHandler);
    };

    signal?.addEventListener("abort", abortHandler, { once: true });
  });
}
