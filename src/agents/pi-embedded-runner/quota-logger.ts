import fs from "node:fs/promises";
import path from "node:path";
import { resolveOpenClawAgentDir } from "../agent-paths.js";

export async function logQuotaBreach(
  error: unknown,
  provider: string,
  modelId: string,
): Promise<void> {
  try {
    const agentDir = resolveOpenClawAgentDir();
    const logPath = path.join(agentDir, "logs", "quota-breach.log");
    await fs.mkdir(path.dirname(logPath), { recursive: true });

    const entry = {
      timestamp: new Date().toISOString(),
      provider,
      modelId,
      error:
        error instanceof Error
          ? {
              name: error.name,
              message: error.message,
              stack: error.stack,
              // Capture extra properties like headers, status, response body if present
              ...(error as Record<string, unknown>),
            }
          : error,
    };

    await fs.appendFile(logPath, JSON.stringify(entry, null, 2) + "\n---\n");
  } catch (err) {
    console.error("Failed to log quota breach:", err);
  }
}
