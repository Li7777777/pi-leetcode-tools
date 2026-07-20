import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";

import type { ToolErrorCode, ToolResult } from "../types.js";
import { TOOL_INPUT_SCHEMAS, TOOL_NAMES } from "./contract.js";
import type { GatewayExecuteOptions, ToolGateway } from "./gateway.js";
import { READ_TOOL_METADATA, type LeetCodeToolMetadata } from "./read-tools.js";
import { WRITE_TOOL_METADATA } from "./write-tools.js";

export interface ToolExecutor {
  execute(
    name: LeetCodeToolMetadata["name"],
    input: unknown,
    options?: GatewayExecuteOptions
  ): Promise<ToolResult<unknown>>;
}

export class LeetCodeModelToolError extends Error {
  readonly code: ToolErrorCode;

  constructor(code: ToolErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "LeetCodeModelToolError";
    this.code = code;
  }
}

const MODEL_ROOT_COMBINATORS = ["anyOf", "oneOf", "allOf", "not"] as const;

/**
 * Pi providers require model tool parameter schemas to have a plain object
 * root. The Gateway still validates against the complete contract schema, so
 * removing root combinators here only widens the model-facing transport shape.
 */
export function createModelToolParameters(schema: TSchema): TSchema {
  const parameters = { ...schema } as TSchema & Record<string, unknown>;
  for (const keyword of MODEL_ROOT_COMBINATORS) {
    delete parameters[keyword];
  }
  return parameters;
}

function createTool(
  executor: ToolExecutor,
  metadata: LeetCodeToolMetadata
): ToolDefinition<TSchema, ToolResult<unknown>> {
  return {
    ...metadata,
    parameters: createModelToolParameters(TOOL_INPUT_SCHEMAS[metadata.name]),
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      const interaction = ctx.hasUI
        ? {
            hasUI: true as const,
            confirm(title: string, message: string, confirmSignal?: AbortSignal) {
              return ctx.ui.confirm(
                title,
                message,
                confirmSignal === undefined ? undefined : { signal: confirmSignal }
              );
            }
          }
        : { hasUI: false as const };
      const result = await executor.execute(metadata.name, params, {
        requestId: toolCallId,
        interaction,
        ...(signal === undefined ? {} : { signal })
      });

      if (!result.ok) {
        throw new LeetCodeModelToolError(result.error.code, result.error.message);
      }

      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: result
      };
    }
  } as ToolDefinition<TSchema, ToolResult<unknown>>;
}

export function createLeetCodeTools(
  executor: ToolExecutor | Pick<ToolGateway, "execute">
): ToolDefinition<TSchema, ToolResult<unknown>>[] {
  const metadataByName = new Map(
    [...READ_TOOL_METADATA, ...WRITE_TOOL_METADATA].map((metadata) => [
      metadata.name,
      metadata
    ])
  );

  return TOOL_NAMES.map((name) => {
    const metadata = metadataByName.get(name);
    if (metadata === undefined) {
      throw new Error(`Missing tool metadata for ${name}`);
    }
    return createTool(executor as ToolExecutor, metadata);
  });
}
