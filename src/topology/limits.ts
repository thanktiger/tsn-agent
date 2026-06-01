export const TOPOLOGY_LIMITS = {
  maxNodes: 256,
  maxLinks: 1024,
  maxPortsPerNode: 64,
  maxOperations: 32,
  maxArtifactBytes: 1_000_000,
  maxJsonDepth: 32,
  maxIngressPayloadBytes: 1_000_000,
} as const;

export type TopologyLimitName = keyof typeof TOPOLOGY_LIMITS;

export function measureJsonDepth(value: unknown): number {
  if (value === null || typeof value !== "object") {
    return 0;
  }

  let maxDepth = 0;
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 1 }];
  const seen = new Set<object>();

  while (stack.length > 0) {
    const item = stack.pop();
    if (!item || item.value === null || typeof item.value !== "object") {
      continue;
    }

    const objectValue = item.value;
    if (seen.has(objectValue)) {
      continue;
    }

    seen.add(objectValue);
    maxDepth = Math.max(maxDepth, item.depth);

    const children = Array.isArray(objectValue)
      ? objectValue
      : Object.values(objectValue as Record<string, unknown>);
    for (const child of children) {
      if (child !== null && typeof child === "object") {
        stack.push({ value: child, depth: item.depth + 1 });
      }
    }
  }

  return maxDepth;
}

export function measureJsonBytes(value: unknown): number {
  const serialized = JSON.stringify(value) ?? "undefined";

  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(serialized).length;
  }

  return measureUtf8Bytes(serialized);
}

function measureUtf8Bytes(value: string): number {
  let bytes = 0;

  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x7f) {
      bytes += 1;
    } else if (codePoint <= 0x7ff) {
      bytes += 2;
    } else if (codePoint <= 0xffff) {
      bytes += 3;
    } else {
      bytes += 4;
    }
  }

  return bytes;
}
