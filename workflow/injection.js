import { createHash } from 'node:crypto';

export const MEMORY_SOURCE = 'dreaming-memory';

// A real pre-step message, committed and displayed by the host just like time-context.
// Only committed, still-visible messages count: retries and compaction must not lose it.
export function memoryInjection({ sections, agent, decision, createUserMessage }) {
  const text = sections.map(section => `${section.name}\n${section.text}`).join('\n\n');
  const digest = createHash('sha256').update(text).digest('hex');
  const messages = decision.messages.filter(message => message.source?.kind !== MEMORY_SOURCE);
  const session = agent.session;
  const visible = new Set(session.surface.nodes);
  let previous;
  for (let index = session.seq - 1; index >= 0; index--) {
    const event = session.eventAt(index);
    if (event?.type === 'user/message' && event.data.source?.kind === MEMORY_SOURCE && visible.has(event.seq)) {
      previous = event.data.source.digest;
      break;
    }
  }
  if (previous === digest) return messages.length === decision.messages.length ? decision : { ...decision, messages };
  const existing = decision.messages.find(message => message.source?.kind === MEMORY_SOURCE && message.source.digest === digest);
  const message = existing ?? createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: MEMORY_SOURCE, form: 'snapshot', sections, digest },
  });
  return { ...decision, messages: [...messages, message] };
}
