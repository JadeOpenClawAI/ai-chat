function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function normalizeWebSearchResultItem(item: unknown): unknown {
  const record = asRecord(item);
  if (!record || record.type !== 'web_search_result') {
    return item;
  }

  const url = typeof record.url === 'string' ? record.url : '';
  const title = typeof record.title === 'string'
    ? record.title
    : url;
  const encryptedContent = typeof record.encrypted_content === 'string'
    ? record.encrypted_content
    : '';

  return {
    ...record,
    title,
    encrypted_content: encryptedContent,
    ...(record.page_age === undefined ? { page_age: null } : {}),
  };
}

function normalizeAnthropicContentBlock(block: unknown): unknown {
  const record = asRecord(block);
  if (!record) {
    return block;
  }

  if (record.type === 'web_search_tool_result' && Array.isArray(record.content)) {
    return {
      ...record,
      content: record.content.map(normalizeWebSearchResultItem),
    };
  }

  return block;
}

function normalizeAnthropicEvent(value: unknown): unknown {
  const record = asRecord(value);
  if (!record) {
    return value;
  }

  if (record.type === 'content_block_start') {
    return {
      ...record,
      content_block: normalizeAnthropicContentBlock(record.content_block),
    };
  }

  return value;
}

function transformSseLine(line: string): string {
  const trimmedLine = line.endsWith('\r') ? line.slice(0, -1) : line;
  if (!trimmedLine.startsWith('data:')) {
    return line;
  }

  const data = trimmedLine.slice(5).trimStart();
  if (!data || data === '[DONE]') {
    return line;
  }

  try {
    return `data: ${JSON.stringify(normalizeAnthropicEvent(JSON.parse(data)))}`;
  } catch {
    return line;
  }
}

function transformAnthropicEventStream(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const reader = body.getReader();
      let buffer = '';

      const flushLines = (flushRemainder: boolean) => {
        let newlineIndex = buffer.indexOf('\n');
        while (newlineIndex >= 0) {
          const line = buffer.slice(0, newlineIndex);
          buffer = buffer.slice(newlineIndex + 1);
          controller.enqueue(encoder.encode(`${transformSseLine(line)}\n`));
          newlineIndex = buffer.indexOf('\n');
        }

        if (flushRemainder && buffer.length > 0) {
          controller.enqueue(encoder.encode(transformSseLine(buffer)));
          buffer = '';
        }
      };

      void (async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              break;
            }
            buffer += decoder.decode(value, { stream: true });
            flushLines(false);
          }

          buffer += decoder.decode();
          flushLines(true);
          controller.close();
        } catch (error) {
          controller.error(error);
        } finally {
          reader.releaseLock();
        }
      })();
    },
  });
}

export function createAnthropicCompatFetch(baseFetch: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    const response = await baseFetch(input, init);
    const contentType = response.headers.get('content-type') ?? '';
    if (!response.body || !contentType.includes('text/event-stream')) {
      return response;
    }

    const headers = new Headers(response.headers);
    headers.delete('content-length');

    return new Response(transformAnthropicEventStream(response.body), {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };
}
