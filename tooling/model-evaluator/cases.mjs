import { randomUUID } from 'node:crypto';

export const suiteRevision = 'model-capability-baseline.v1';
export const cases = [
  { id: 'instruction', title: 'Exact instruction following' },
  { id: 'json', title: 'Structured response' },
  { id: 'tool', title: 'Tool selection and arguments' },
  { id: 'result', title: 'Use a Tool result' },
  { id: 'calls', title: 'Multiple independent calls' },
  { id: 'correction', title: 'Correct a rejected argument' },
];
export const limitations = [
  'Small synthetic cases, not a coding benchmark or a product qualification.',
  'Results describe this model, endpoint, settings and suite at the recorded time.',
  'Passing repeated trials does not guarantee reliability in long or real-world tasks.',
  'Tools are simulated. No model-proposed code, command or file operation is executed.',
];

export function scenario(id) {
  const marker = randomUUID();
  const tool = { type: 'function', function: { name: 'lookup_record', description: 'Read the record with the exact supplied key.',
    parameters: { type: 'object', properties: { key: { type: 'string', description: 'Exact record key.' } }, required: ['key'], additionalProperties: false } } };
  const messages = [];
  const ask = text => messages.push({ role: 'user', content: text });
  const matchCalls = (turn, keys) => turn.calls.length === keys.length && keys.every(key =>
    turn.calls.filter(c => c.name === 'lookup_record' && c.arguments &&
      Object.keys(c.arguments).length === 1 && c.arguments.key === key).length === 1);
  if (id === 'instruction') {
    ask(`Reply with exactly ${marker}, with no other text.`);
    return { messages, tools: [], check: t => t.calls.length === 0 && t.text.trim() === marker };
  }
  if (id === 'json') {
    ask(`Return only a JSON object, without markdown: key "marker" must be "${marker}" and key "count" must be the number 3. No additional fields.`);
    return { messages, tools: [], check: t => {
      try { const v = JSON.parse(t.text); return t.calls.length === 0 && v.marker === marker && v.count === 3 && Object.keys(v).length === 2; }
      catch { return false; }
    } };
  }
  if (id === 'calls') {
    ask(`Call lookup_record twice in this response, once for key "a-${marker}" and once for "b-${marker}". These lookups are independent.`);
    return { messages, tools: [tool], check: t => matchCalls(t, [`a-${marker}`, `b-${marker}`]) };
  }
  ask(`Use lookup_record with key "${marker}".${id === 'result' ? ' After receiving its result, reply with only the returned value.' : ''}`);
  return { messages, tools: [tool], check: t => matchCalls(t, [marker]),
    ...(id === 'result' ? { followup: () => ({ result: { value: `observed-${randomUUID()}` } }),
      checkFollowup: (t, value) => t.calls.length === 0 && t.text.trim() === value.result.value } : {}),
    ...(id === 'correction' ? { followup: () => ({ result: { error: 'key_rejected', requiredKey: `corrected-${randomUUID()}` } }),
      checkFollowup: (t, value) => matchCalls(t, [value.result.requiredKey]) } : {}),
  };
}
