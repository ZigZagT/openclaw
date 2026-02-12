export function extractRetryAfterMs(error: unknown): number | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }

  const record = error as Record<string, unknown>;

  // Headers (Anthropic/OpenAI often throw errors with a 'headers' property)
  if (record.headers && typeof record.headers === "object") {
    const headers = record.headers as Record<string, string | string[]>;
    const keys = Object.keys(headers);
    const retryKey = keys.find((k) => k.toLowerCase() === "retry-after");
    if (retryKey) {
      const val = headers[retryKey];
      const valStr = Array.isArray(val) ? val[0] : val;
      if (valStr) {
        // If numeric, it's seconds
        if (/^\d+(\.\d+)?$/.test(valStr)) {
          return Math.ceil(parseFloat(valStr) * 1000);
        }
        // Try parsing as HTTP-date
        const date = Date.parse(valStr);
        if (!isNaN(date)) {
          const delta = date - Date.now();
          return delta > 0 ? delta : 0;
        }
      }
    }
  }

  // Try to parse direct properties
  if (typeof record.retryAfter === "number") {
    return record.retryAfter * 1000;
  }
  if (typeof record.retry_after === "number") {
    return record.retry_after * 1000;
  }

  return undefined;
}
