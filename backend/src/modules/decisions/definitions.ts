import { z } from 'zod';

const uuid = z.string().uuid();
const option = z.string().trim().min(1).max(160);
const options = z
  .array(option)
  .min(2)
  .max(8)
  .refine((values) => new Set(values.map((value) => value.toLowerCase())).size === values.length);
const label = z.string().trim().min(1).max(80);
const baseQuestion = {
  id: uuid,
  title: z.string().trim().min(3).max(300),
  required: z.boolean(),
  visibleIf: z
    .object({
      questionId: uuid,
      equals: z.string().trim().min(1).max(160),
    })
    .strict()
    .optional(),
};
const question = z
  .discriminatedUnion('type', [
    z.object({ ...baseQuestion, type: z.literal('single_choice'), options }).strict(),
    z.object({ ...baseQuestion, type: z.literal('multiple_choice'), options }).strict(),
    z.object({ ...baseQuestion, type: z.literal('ranked_choice'), options }).strict(),
    z
      .object({
        ...baseQuestion,
        type: z.literal('text'),
        maxLength: z.number().int().min(1).max(2000),
        placeholder: z.string().trim().max(200).optional(),
      })
      .strict(),
    z
      .object({
        ...baseQuestion,
        type: z.literal('rating_scale'),
        min: z.number().int().min(0).max(9),
        max: z.number().int().min(1).max(10),
        minLabel: z.string().trim().max(120).optional(),
        maxLabel: z.string().trim().max(120).optional(),
      })
      .strict(),
  ])
  .refine((q) => q.type !== 'rating_scale' || q.min < q.max);

export const definitionFields = {
  unitId: uuid,
  title: z.string().trim().min(3).max(160),
  description: z.string().trim().max(3000),
  options: z.array(option).max(8),
  quorum: z.number().int().min(1).max(100),
  opensAt: z.string().datetime({ offset: true }).optional(),
  closesAt: z.string().datetime({ offset: true }),
  kind: z.enum(['poll', 'referendum', 'survey', 'election']).optional(),
  privacy: z.enum(['named', 'anonymous']).optional(),
  anonymousMinElectorate: z.number().int().min(2).max(1000).optional(),
  governanceMode: z.enum(['advisory', 'binding_review']).optional(),
  includedUnitIds: z.array(uuid).min(1).max(25).optional(),
  excludedUnitIds: z.array(uuid).max(25).optional(),
  referendumLabels: z
    .object({
      yes: label.optional(),
      no: label.optional(),
      abstain: label.optional(),
    })
    .strict()
    .optional(),
  threshold: z.number().int().min(50).max(100).optional(),
  questions: z.array(question).min(1).max(20).optional(),
};

export function validDefinition(value: {
  unitId: string;
  kind?: string;
  privacy?: string;
  anonymousMinElectorate?: number;
  options: string[];
  threshold?: number;
  opensAt?: string;
  closesAt: string;
  includedUnitIds?: string[];
  excludedUnitIds?: string[];
  referendumLabels?: { yes?: string; no?: string; abstain?: string };
  questions?: z.infer<typeof question>[];
}) {
  if (value.anonymousMinElectorate !== undefined && (value.privacy ?? 'named') !== 'anonymous') {
    return false;
  }
  if (value.opensAt && new Date(value.opensAt).getTime() >= new Date(value.closesAt).getTime()) {
    return false;
  }
  if (value.includedUnitIds && !value.includedUnitIds.includes(value.unitId)) {
    return false;
  }
  if (
    value.includedUnitIds &&
    value.excludedUnitIds &&
    value.excludedUnitIds.some((id) => value.includedUnitIds!.includes(id))
  ) {
    return false;
  }
  const kind = value.kind ?? 'poll';
  if (value.referendumLabels && kind !== 'referendum') return false;
  if (kind === 'survey') {
    if (
      value.options.length !== 0 ||
      value.threshold !== undefined ||
      !value.questions?.length
    ) {
      return false;
    }
    const seen = new Set<string>();
    for (const q of value.questions) {
      if (seen.has(q.id)) return false;
      if (q.visibleIf && !seen.has(q.visibleIf.questionId)) return false;
      seen.add(q.id);
    }
    return true;
  }
  if (value.questions !== undefined) return false;
  if (kind === 'referendum') {
    return (
      value.threshold !== undefined &&
      JSON.stringify(value.options) === JSON.stringify(['Yes', 'No', 'Abstain'])
    );
  }
  return value.threshold === undefined && options.safeParse(value.options).success;
}

export const answerValues = z.record(
  uuid,
  z.union([
    z.number().int().min(0).max(10),
    z.string().max(2000),
    z.array(z.number().int().min(0).max(7)).min(1).max(8),
  ])
);
