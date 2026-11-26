import { createHash } from "node:crypto";
import { z } from "zod";

export const exeDevMachineResourceSchema = z
  .object({
    key: z.string().min(1),
    vmName: z.string().min(1),
    accountEmail: z.string().min(1),
  })
  .strict();

export type ExeDevMachineResource = z.infer<typeof exeDevMachineResourceSchema>;

export function readExeDevMachineResource(value: unknown): ExeDevMachineResource {
  return exeDevMachineResourceSchema.parse(value);
}

export function vmNameForKey(key: string): string {
  return `bb-${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;
}
