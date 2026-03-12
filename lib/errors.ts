function toSerializableValue(
  value: unknown,
  seen: WeakSet<object>,
  depth = 0,
): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (depth >= 5) {
    return '[Max depth reached]';
  }
  if (value instanceof Error) {
    return serializeError(value, seen, depth + 1);
  }
  if (typeof value !== 'object') {
    return String(value);
  }
  if (seen.has(value)) {
    return '[Circular]';
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => toSerializableValue(item, seen, depth + 1));
  }
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    output[key] = toSerializableValue(entry, seen, depth + 1);
  }
  return output;
}

function serializeError(
  error: Error,
  seen: WeakSet<object>,
  depth = 0,
): Record<string, unknown> {
  const output: Record<string, unknown> = {
    name: error.name,
    message: error.message,
  };
  if (error.stack) {
    output.stack = error.stack;
  }
  if ('cause' in error) {
    const cause = (error as Error & { cause?: unknown }).cause;
    if (cause !== undefined) {
      output.cause = toSerializableValue(cause, seen, depth + 1);
    }
  }
  for (const [key, value] of Object.entries(error)) {
    if (key === 'name' || key === 'message' || key === 'stack' || key === 'cause') {
      continue;
    }
    output[key] = toSerializableValue(value, seen, depth + 1);
  }
  return output;
}

export function stringifyErrorDetails(error: unknown): string {
  if (typeof error === 'string') {
    return error;
  }
  if (error instanceof Error) {
    try {
      return JSON.stringify(serializeError(error, new WeakSet()), null, 2);
    } catch {
      return error.stack || `${error.name}: ${error.message}`;
    }
  }
  try {
    return JSON.stringify(toSerializableValue(error, new WeakSet()), null, 2);
  } catch {
    return String(error);
  }
}
