import { z } from "zod";

export const fabFilterProbeResultSchema = z.strictObject({
  plugin: z.string().min(1),
  format: z.enum(["VST3", "CLAP"]),
  parameters: z.array(z.strictObject({
    index: z.number().int().nonnegative(),
    name: z.string(),
    ident: z.string(),
    normalizedValue: z.number().min(0).max(1),
    formattedValue: z.string(),
  })).max(4096),
});

export type FabFilterProbeResult = z.infer<typeof fabFilterProbeResultSchema>;
