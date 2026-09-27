import { z } from 'zod';
import { stackInfoSchema, type Expect, type Equal } from '@bob-deploy/contracts';
import type { InstallPlan, FixResult, Diagnosis } from '@bob-deploy/contracts';

// packages/contracts is frozen after M0 (CLAUDE.md), and InstallPlan/FixResult/Diagnosis have no
// zod schema there (only StackInfo does, re-exported below). These mirror the TS interfaces
// exactly, following the same `satisfies z.ZodType<T>` + compile-time equality check pattern
// contracts itself uses, so a future drift between the interface and this schema fails to build
// rather than silently validating the wrong shape.

export { stackInfoSchema };

export const installPlanSchema = z.object({
  runtime: z
    .object({
      name: z.enum(['node', 'python']),
      version: z.string(),
    })
    .nullable(),
  aptPackages: z.array(z.string()),
  notes: z.array(z.string()),
}) satisfies z.ZodType<InstallPlan>;
type _CheckInstallPlan = Expect<Equal<z.infer<typeof installPlanSchema>, InstallPlan>>;

export const fixResultSchema = z.object({
  fixed: z.boolean(),
  summary: z.string(),
  changedFiles: z.array(z.string()),
  requestedCommands: z.array(z.string()),
}) satisfies z.ZodType<FixResult>;
type _CheckFixResult = Expect<Equal<z.infer<typeof fixResultSchema>, FixResult>>;

export const diagnosisSchema = z.object({
  summary: z.string(),
  likelyCause: z.string(),
  userMessage: z.string(),
  proposedAction: z.enum(['update_with_fix', 'rollback', 'maintenance', 'none']),
  fixInstructions: z.string().optional(),
}) satisfies z.ZodType<Diagnosis>;
type _CheckDiagnosis = Expect<Equal<z.infer<typeof diagnosisSchema>, Diagnosis>>;
