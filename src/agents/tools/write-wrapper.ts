import { createWriteTool } from "@mariozechner/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { type AnyAgentTool } from "../pi-tools.types.js";

export class WriteVerificationError extends Error {
  constructor(public filePath: string) {
    super(
      `WriteVerificationError: File '${filePath}' not found on disk after write operation. The write may have failed silently or been interrupted.`,
    );
    this.name = "WriteVerificationError";
  }
}

/**
 * Wraps the standard write tool to verify the file exists after writing.
 */
export function createVerifiedWriteTool(workspaceRoot: string): AnyAgentTool {
  const originalTool = createWriteTool(workspaceRoot) as unknown as AnyAgentTool;

  return {
    ...originalTool,
    execute: async (
      toolUseId: string,
      params: unknown,
      signal?: AbortSignal,
      onUpdate?: (update: unknown) => void,
    ): Promise<unknown> => {
      // Execute the original write operation
      const result = await originalTool.execute(toolUseId, params, signal, onUpdate);

      // Extract path from params
      // The params passed here are what the model sent (or normalized before this wrapper if nested)
      const rawPath = params?.path || params?.file_path;

      if (typeof rawPath === "string") {
        // Resolve against workspace root
        const resolvedPath = path.resolve(workspaceRoot, rawPath);

        // Check if file exists
        if (!fs.existsSync(resolvedPath)) {
          throw new WriteVerificationError(rawPath);
        }
      }

      return result;
    },
  };
}
