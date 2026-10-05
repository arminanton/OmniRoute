type SetLkgp = (
  comboName: string,
  modelId: string,
  providerId: string,
  connectionId?: string
) => Promise<void>;

export interface RecordLkgpPinInput {
  comboName: string;
  comboId?: string | null;
  executionKey: string;
  provider: string;
  connectionId?: string;
  setLKGP?: SetLkgp;
}

/** Record execution-specific and combo-level pins without writing a duplicate key. */
export async function recordLkgpPin({
  comboName,
  comboId,
  executionKey,
  provider,
  connectionId,
  setLKGP: setLKGPFn,
}: RecordLkgpPinInput): Promise<void> {
  const set = setLKGPFn ?? (await import("@/lib/db/settings")).setLKGP;
  const comboKey = comboId || comboName;
  if (comboKey === comboName) {
    await set(comboName, comboKey, provider, connectionId);
    return;
  }
  await Promise.all([
    set(comboName, executionKey, provider, connectionId),
    set(comboName, comboKey, provider, connectionId),
  ]);
}
