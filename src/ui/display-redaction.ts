export function redactProviderNamesForDisplay(value: string): string {
  return value
    .replace(/claude-run-/gi, "agent-run-")
    .replace(/Claude\s*Code/gi, "智能助手工具")
    .replace(/Claude\s*Agent\s*SDK/gi, "智能助手运行时")
    .replace(/Claude\s*Agent/gi, "智能助手")
    .replace(/Claude\s*SDK/gi, "智能助手运行时")
    .replace(/Claude/gi, "智能助手")
    .replace(/智能助手-run-/g, "agent-run-")
    .replace(/智能助手\s+(请求|已|暂时|正在|返回|运行|执行|没有|不可用|工具|运行时)/g, "智能助手$1")
    .replace(/claude_api_key/gi, "agent_api_key");
}

export function redactProviderNamesInValue(value: unknown): unknown {
  if (typeof value === "string") {
    return redactProviderNamesForDisplay(value);
  }

  if (Array.isArray(value)) {
    return value.map(redactProviderNamesInValue);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, innerValue]) => [
        redactProviderNamesForDisplay(key),
        redactProviderNamesInValue(innerValue),
      ]),
    );
  }

  return value;
}
