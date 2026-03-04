import { tool } from 'ai';
import { z } from 'zod/v3';
import type { BuiltinToolMetadata } from '@/lib/tools/builtins/types';

interface DuckDuckGoTopic {
  Text?: string;
  FirstURL?: string;
  Topics?: DuckDuckGoTopic[];
}

interface DuckDuckGoResponse {
  AbstractText?: string;
  AbstractURL?: string;
  RelatedTopics?: DuckDuckGoTopic[];
}

function flattenDuckDuckGoTopics(topics: DuckDuckGoTopic[] | undefined): Array<{ title: string; url: string }> {
  if (!topics?.length) {
    return [];
  }

  const flat: Array<{ title: string; url: string }> = [];
  for (const item of topics) {
    if (Array.isArray(item.Topics) && item.Topics.length > 0) {
      flat.push(...flattenDuckDuckGoTopics(item.Topics));
      continue;
    }
    if (item.Text && item.FirstURL) {
      flat.push({ title: item.Text, url: item.FirstURL });
    }
  }
  return flat;
}

export const webSearchTool = tool({
  description:
    'Searches the web for information about a topic. Returns relevant snippets and URLs.',
  inputSchema: z.object({
    query: z.string().describe('The search query'),
    numResults: z
      .number()
      .min(1)
      .max(10)
      .default(5)
      .describe('Number of results to return (1-10)'),
  }),
  execute: async ({ query, numResults }) => {
    try {
      const endpoint = new URL('https://api.duckduckgo.com/');
      endpoint.searchParams.set('q', query);
      endpoint.searchParams.set('format', 'json');
      endpoint.searchParams.set('no_html', '1');
      endpoint.searchParams.set('no_redirect', '1');
      endpoint.searchParams.set('skip_disambig', '1');

      const response = await fetch(endpoint, {
        headers: { 'user-agent': 'ai-chat/1.0' },
      });

      if (!response.ok) {
        return {
          query,
          error: `Search request failed with status ${response.status}`,
          results: [],
          totalResults: 0,
        };
      }

      const payload = await response.json() as DuckDuckGoResponse;
      const related = flattenDuckDuckGoTopics(payload.RelatedTopics);
      const results = [
        ...(payload.AbstractText && payload.AbstractURL
          ? [{ title: payload.AbstractText, url: payload.AbstractURL }]
          : []),
        ...related,
      ]
        .slice(0, numResults)
        .map((item) => ({
          title: item.title,
          url: item.url,
          snippet: item.title,
        }));

      return {
        query,
        provider: 'duckduckgo',
        results,
        totalResults: results.length,
      };
    } catch (err) {
      return {
        query,
        error: err instanceof Error ? err.message : String(err),
        results: [],
        totalResults: 0,
      };
    }
  },
});

export const webSearchToolMetadata: BuiltinToolMetadata = {
  icon: '🌐',
  description: 'Web search',
  expectedDurationMs: 2000,
  inputs: ['query (string)', 'numResults (1-10)'],
  outputs: ['provider (duckduckgo)', 'results[] (title/url/snippet)', 'totalResults (number)', 'error (string?)'],
};
