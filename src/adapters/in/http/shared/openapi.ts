import { z } from 'zod';

/** JSON Schema (Swagger) a partir do schema Zod de entrada. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const schema = (s: z.ZodType): any =>
  z.toJSONSchema(s, { io: 'input', unrepresentable: 'any' });
