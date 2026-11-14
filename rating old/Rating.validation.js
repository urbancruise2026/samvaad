const { z } = require("zod");
const ApiError = require("../../utils/ApiError");

const periodSchema = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Period must be in YYYY-MM format");

const entryPatchSchema = z.object({
  rating: z.number().int().min(1, "Rating must be 1-5").max(5, "Rating must be 1-5").nullable().optional(),
  remarks: z.string().max(1000, "Remarks can be at most 1000 characters").optional(),
  value: z.number().min(0).max(1000).nullable().optional(),
});

const ratingSubmissionSchema = z.object({
  period: periodSchema.optional(),
  // Partial map - only the fields being changed need to be sent.
  fieldEntries: z.record(z.string().max(64), entryPatchSchema),
});

const fieldDefSchema = z.object({
  key: z
    .string()
    .regex(/^[A-Za-z0-9_]{1,64}$/, "Invalid field key")
    .optional(),
  label: z.string().trim().min(1, "Field name is required").max(60, "Field name is too long"),
  isNumeric: z.boolean().optional(),
});

const fieldConfigSchema = z.object({
  sales: z.array(fieldDefSchema).max(15),
  conduct: z.array(fieldDefSchema).max(15),
  contribution: z.array(fieldDefSchema).max(15),
});

const parse = (schema, data) => {
  const result = schema.safeParse(data);
  if (!result.success) {
    const message = result.error.issues
      .map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message))
      .join("; ");
    throw new ApiError(400, message);
  }
  return result.data;
};

module.exports = {
  periodSchema,
  ratingSubmissionSchema,
  fieldConfigSchema,
  parse,
};
