export interface ArrayShrinkWarning {
  field: string;
  bodyLength: number;
  backupLength: number;
  reason: string;
}

/**
 * Compare array field sizes in a PUT/PATCH body against the backup (current state).
 * Returns warnings when the body has significantly fewer items than the backup,
 * which usually means truncated query results leaked into the write payload.
 *
 * @param body - The request body being sent
 * @param backupData - The full data from the pre-write backup
 * @param options.threshold - Ratio below which to warn (default 0.5 = body < 50% of backup)
 */
export function detectArrayShrinkage(
  body: Record<string, unknown>,
  backupData: unknown,
  options?: { threshold?: number }
): ArrayShrinkWarning[] {
  if (typeof backupData !== "object" || backupData === null || Array.isArray(backupData)) {
    return [];
  }

  const threshold = options?.threshold ?? 0.5;
  const minBackupLength = 5;
  const warnings: ArrayShrinkWarning[] = [];
  const backup = backupData as Record<string, unknown>;

  // Level 1: direct fields
  for (const [key, bodyVal] of Object.entries(body)) {
    const backupVal = backup[key];
    if (Array.isArray(bodyVal) && Array.isArray(backupVal)) {
      if (
        backupVal.length >= minBackupLength &&
        bodyVal.length / backupVal.length < threshold
      ) {
        warnings.push({
          field: key,
          bodyLength: bodyVal.length,
          backupLength: backupVal.length,
          reason:
            `Request body has ${bodyVal.length} items in '${key}' but the current resource has ${backupVal.length}. ` +
            `This PUT/PATCH will replace the entire array — ${backupVal.length - bodyVal.length} items will be lost.`,
        });
      }
    }

    // Level 2: one level of nesting
    if (
      typeof bodyVal === "object" && bodyVal !== null && !Array.isArray(bodyVal) &&
      typeof backupVal === "object" && backupVal !== null && !Array.isArray(backupVal)
    ) {
      const bodyObj = bodyVal as Record<string, unknown>;
      const backupObj = backupVal as Record<string, unknown>;
      for (const [nestedKey, nestedBodyVal] of Object.entries(bodyObj)) {
        const nestedBackupVal = backupObj[nestedKey];
        if (Array.isArray(nestedBodyVal) && Array.isArray(nestedBackupVal)) {
          if (
            nestedBackupVal.length >= minBackupLength &&
            nestedBodyVal.length / nestedBackupVal.length < threshold
          ) {
            warnings.push({
              field: `${key}.${nestedKey}`,
              bodyLength: nestedBodyVal.length,
              backupLength: nestedBackupVal.length,
              reason:
                `Request body has ${nestedBodyVal.length} items in '${key}.${nestedKey}' but the current resource has ${nestedBackupVal.length}. ` +
                `This PUT/PATCH will replace the entire array — ${nestedBackupVal.length - nestedBodyVal.length} items will be lost.`,
            });
          }
        }
      }
    }
  }

  return warnings;
}
