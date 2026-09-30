/**
 * The staff assistant's tool loop.
 *
 * The model picks parameters; this module executes them against the vetted
 * query layer and hands back structured results. Tool inputs are validated with
 * zod before they reach the database — the model is an untrusted source of
 * parameters, and an enum it invents should be a clean error the model can
 * correct, not a query.
 *
 * What the model can see is deliberately narrow: counts, rates, period labels,
 * cohort labels, hospital names. No staff notes, no task payloads, no
 * free-text a hospital typed. That is partly privacy and partly injection —
 * hospital-entered prose reaching the model would be a route for instructions
 * to arrive dressed as data.
 */
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { env } from '@/config/env.js';
import { HttpError } from '@/middleware/errors.js';
import { logger } from '@/config/logger.js';
import { computeEngagementMetrics } from '@/modules/reports/engagement-metrics.service.js';
import { engagementNarrative, statutorySentence } from '@/modules/reports/engagement-metrics.js';
import { listDimensions, queryEngagement } from './metrics-query.service.js';
import { ASSISTANT_MODEL, SYSTEM_PROMPT, TOOLS } from './assistant.prompt.js';
import type { MetricsQuery } from './metrics-query.js';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** What the UI shows under "how this was calculated". */
export interface ToolTrace {
  tool: string;
  input: unknown;
  ok: boolean;
  summary: string;
}

export interface AssistantReply {
  text: string;
  trace: ToolTrace[];
  stopReason: string;
}

const PeriodSchema = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('year') }),
    z.object({ kind: z.literal('quarter'), quarter: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]) }),
    z.object({ kind: z.literal('month'), month: z.number().int().min(1).max(12) }),
    z.object({
      kind: z.literal('months'),
      from: z.number().int().min(1).max(12),
      to: z.number().int().min(1).max(12),
    }),
  ])
  .refine((p) => p.kind !== 'months' || p.from <= p.to, { message: 'from must be <= to' });

const QuerySchema = z.object({
  programYear: z.number().int().min(2020).max(2100),
  metric: z.enum(['enrollment', 'survey', 'coaching', 'meetings', 'dataSubmission']).optional(),
  initiatives: z.array(z.enum(['TTT', 'SPARK', 'SOAR', 'NEST'])).min(1).optional(),
  period: PeriodSchema.optional(),
  groupBy: z.enum(['none', 'initiative', 'period', 'hospital', 'cohort']).optional(),
  unit: z.enum(['task', 'hospital']).optional(),
  cohortTag: z.string().max(120).optional(),
});

const DimensionsSchema = z.object({ programYear: z.number().int().min(2020).max(2100) });
const SummarySchema = z.object({
  programYear: z.number().int().min(2020).max(2100),
  cohortTag: z.string().max(120).optional(),
});

/** One-line description of a result, for the UI trace. */
function summarise(tool: string, result: unknown): string {
  if (tool === 'query_engagement') {
    const r = result as Awaited<ReturnType<typeof queryEngagement>>;
    const warnings =
      r.caveats.filter((c) => c.severity === 'warning').length +
      r.groups.reduce((n, g) => n + g.caveats.filter((c) => c.severity === 'warning').length, 0);
    return `${r.groups.length} row(s), ${warnings} warning(s)`;
  }
  if (tool === 'grant_summary') return 'five-metric summary + statutory compliance';
  if (tool === 'list_dimensions') return 'available programs, periods and tags';
  return 'ok';
}

async function runTool(name: string, rawInput: unknown): Promise<unknown> {
  switch (name) {
    case 'query_engagement': {
      const q = QuerySchema.parse(rawInput) as MetricsQuery;
      return queryEngagement(q);
    }
    case 'list_dimensions': {
      const { programYear } = DimensionsSchema.parse(rawInput);
      return listDimensions(programYear);
    }
    case 'grant_summary': {
      const { programYear, cohortTag } = SummarySchema.parse(rawInput);
      const summary = await computeEngagementMetrics(programYear, cohortTag ?? null);
      // The narrative is included so the assistant quotes CPCQC's own wording
      // rather than paraphrasing it into something subtly different.
      return {
        ...summary,
        narrative: engagementNarrative(summary),
        statutorySentence: statutorySentence(summary.statutory),
      };
    }
    default:
      throw new Error(`unknown tool ${name}`);
  }
}

export function assistantAvailable(): boolean {
  return Boolean(env.ANTHROPIC_API_KEY);
}

export async function runAssistant(messages: ChatMessage[]): Promise<AssistantReply> {
  if (!env.ANTHROPIC_API_KEY) {
    throw new HttpError(
      503,
      'The assistant is not configured on this environment (ANTHROPIC_API_KEY is unset).',
    );
  }
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const convo: Anthropic.MessageParam[] = messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));
  const trace: ToolTrace[] = [];

  for (let step = 0; step < env.ASSISTANT_MAX_STEPS; step += 1) {
    const res = await client.messages.create({
      model: env.ASSISTANT_MODEL || ASSISTANT_MODEL,
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages: convo,
    });

    const toolUses = res.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
    );

    if (toolUses.length === 0 || res.stop_reason !== 'tool_use') {
      const text = res.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();
      return { text, trace, stopReason: res.stop_reason ?? 'end_turn' };
    }

    convo.push({ role: 'assistant', content: res.content });
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const use of toolUses) {
      try {
        const out = await runTool(use.name, use.input);
        trace.push({ tool: use.name, input: use.input, ok: true, summary: summarise(use.name, out) });
        results.push({
          type: 'tool_result',
          tool_use_id: use.id,
          content: JSON.stringify(out),
        });
      } catch (err) {
        // Hand the model the validation error so it can correct its parameters,
        // rather than failing the whole question.
        const message = err instanceof z.ZodError ? JSON.stringify(err.flatten()) : String(err);
        logger.warn({ tool: use.name, input: use.input, err: message }, 'assistant tool failed');
        trace.push({ tool: use.name, input: use.input, ok: false, summary: message.slice(0, 200) });
        results.push({
          type: 'tool_result',
          tool_use_id: use.id,
          is_error: true,
          content: message.slice(0, 1000),
        });
      }
    }
    convo.push({ role: 'user', content: results });
  }

  return {
    text:
      'I could not resolve that within the allowed number of steps. Try narrowing the question ' +
      'to one metric, one program and one period.',
    trace,
    stopReason: 'max_steps',
  };
}
