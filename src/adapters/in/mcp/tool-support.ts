import { z } from 'zod';
import { DomainError } from '../../../domain/shared/domain-error.js';

export type ToolResult = {
  content: { type: 'text'; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

export async function run(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    const data = await fn();
    const structured = (
      data && typeof data === 'object' && !Array.isArray(data) ? data : { result: data }
    ) as Record<string, unknown>;
    return {
      content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
      structuredContent: structured,
    };
  } catch (error) {
    const payload =
      error instanceof DomainError
        ? { error: error.code, message: error.message, details: error.details }
        : { error: 'INTERNAL', message: error instanceof Error ? error.message : String(error) };
    return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], isError: true };
  }
}

export const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
export const idArg = z.object({ id: z.string().describe('Id da nota no açaínfe') });
