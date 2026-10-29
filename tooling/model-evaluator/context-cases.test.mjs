import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contextCases, contextScenario } from './context-cases.mjs';
import { Evaluation, summarize } from './evaluation.mjs';
import { configuration } from './connection.mjs';
import { selectedCases } from './cases.mjs';

const turn = value => ({ calls: [], text: JSON.stringify(value) });
const representation = scenario => ({ facts: scenario.oracle.facts.map(({ id, value, sources }) => ({ id, value, sources })), background: [] });
const directions = ['source_to_candidate', 'candidate_to_source', 'relationships', 'precision'];
const conclusions = (requirements, missing) => ({ requirements, missing,
  directions: Object.fromEntries(directions.map(key => [key, missing.length ? 'unsupported' : 'supported'])),
  basis: Object.fromEntries(Object.keys(requirements).map(key => [key, 'Controlled test evidence.'])) });

for (const spec of contextCases.filter(c => c.dimension !== 'checking')) {
  test(`${spec.id}: original facts, references and subsequent use are independently checked`, () => {
    const sc = contextScenario(spec.id), value = representation(sc), first = turn(value);
    assert.equal(sc.assess(first).passed, true);
    const changed = structuredClone(value); changed.facts[0].value = 'wrong';
    assert.equal(sc.assess(turn(changed)).category, 'semantic_mismatch');
    const omitted = structuredClone(value); omitted.facts.pop();
    assert.equal(sc.assess(turn(omitted)).category, 'semantic_mismatch');
    assert.equal(sc.assess(turn({ ...value, background: ['[]'] })).category, 'invalid_structure');
    const badReference = structuredClone(value); badReference.facts[0].sources = ['invented'];
    assert.equal(sc.assess(turn(badReference)).category, 'invalid_structure');
    const duplicate = structuredClone(value); duplicate.facts.push(duplicate.facts[0]);
    assert.equal(sc.assess(turn(duplicate)).category, 'invalid_structure');
    assert.equal(sc.assess({ calls: [{}], text: first.text }).category, 'invalid_structure');
    const reversed = structuredClone(value); reversed.facts.reverse();
    assert.equal(sc.assess(turn(reversed)).passed, true);
    let next = sc.continueWith(first, 'generation');
    if (spec.id === 'context-repeat') {
      assert.equal(next.phase, 'regeneration');
      assert.equal(next.assess(first).passed, true);
      assert.equal(next.assess(turn(changed)).passed, false);
      next = sc.continueWith(first, next.phase);
    }
    assert.equal(next.phase, 'use');
    assert.equal(next.assess(turn(sc.oracle.subsequentAnswers)).passed, true);
    const wrong = { ...sc.oracle.subsequentAnswers }; wrong[Object.keys(wrong)[0]] = 'invented';
    assert.equal(next.assess(turn(wrong)).category, 'semantic_mismatch');
    const body = JSON.parse(next.messages[0].content.split('\n').at(-1));
    assert.deepEqual(Object.keys(body).sort(), ['questions', 'representation']);
    assert.equal(sc.continueWith(turn(sc.oracle.subsequentAnswers), 'use'), null);
  });
}

for (const spec of contextCases.filter(c => c.dimension === 'checking')) {
  test(`${spec.id}: checking is scored against controlled truth, not self-approval`, () => {
    const sc = contextScenario(spec.id), truth = sc.oracle;
    const valid = conclusions(truth.requirements, truth.missing);
    const assessment = sc.assess(turn(valid));
    assert.equal(assessment.passed, true);
    assert.equal(assessment.falseAcceptance, false);
    assert.equal(assessment.falseRejection, false);
    const keys = Object.keys(truth.requirements);
    const approveAll = sc.assess(turn(conclusions(Object.fromEntries(keys.map(k => [k, 'supported'])), [])));
    assert.equal(approveAll.falseAcceptance, spec.candidateClass === 'faulty');
    const rejectAll = sc.assess(turn(conclusions(Object.fromEntries(keys.map(k => [k, 'unsupported'])), keys)));
    assert.equal(rejectAll.falseRejection, true);
    assert.equal(rejectAll.passed, false);
    const unknown = sc.assess(turn(conclusions(Object.fromEntries(keys.map(k => [k, 'unknown'])), keys)));
    assert.equal(unknown.unknownJudgment, true);
    assert.equal(unknown.passed, false);
    const inconsistent = structuredClone(valid); inconsistent.missing = spec.candidateClass === 'faithful' ? ['target'] : [];
    assert.equal(sc.assess(turn(inconsistent)).passed, false);
    assert.equal(sc.assess(turn({ ...valid, directions: ['source_to_candidate', 'source_to_candidate'] })).category, 'invalid_structure');
    assert.equal(sc.assess({ calls: [], text: '```json\n{}\n```' }).category, 'invalid_structure');
    const submitted = JSON.parse(sc.messages[0].content.split('\n').at(-1));
    assert.deepEqual(Object.keys(submitted).sort(), ['candidate', 'outputSchema', 'requirements', 'sources', 'trial']);
    assert.ok(!('expected' in submitted));
  });
}

// Controlled endpoint only: these parsers construct known fixture answers, not a
// production semantic judge. The evaluator itself uses independent answer keys.
function answerFixture(content) {
  if (content.startsWith('Assess')) {
    const { sources, candidate } = JSON.parse(content.split('\n').at(-1));
    const boundary = Number(sources[1].text.match(/image (\d+)/)[1]);
    const target = Number(sources[0].text.match(/TARGET is (\d+)/)[1]);
    const valid = {
      scope: candidate.includes(`images ${boundary}-10`) || candidate.includes(`from image ${boundary} onward`),
      alpha: /alpha/i.test(candidate),
      target: candidate.includes(`TARGET: ${target}.`) || candidate.includes(`TARGET remains ${target}.`),
      version: !candidate.includes('observed editor version is 12'),
    };
    return conclusions(Object.fromEntries(Object.entries(valid).map(([key, ok]) => [key, ok ? 'supported' : 'unsupported'])), Object.keys(valid).filter(key => !valid[key]));
  }
  if (content.startsWith('Use only')) {
    const { representation, questions } = JSON.parse(content.split('\n').at(-1));
    const facts = Object.fromEntries(representation.facts.map(f => [f.id, f.value]));
    if ('port' in questions) return { port: facts.current_port };
    if ('executed' in questions) return { executed: facts.command_executed, version: facts.sdk_version, missing: false };
    return { earlier_radius: facts.earlier_method.radius, later_radius: facts.later_method.radius,
      alpha: facts.later_method.alpha, target: facts.target, verified_version: facts.version.observed };
  }
  if (content.includes('Re-express the following')) return JSON.parse(content.split('\n').at(-1));
  const sources = JSON.parse(content.split('Sources in order:\n')[1]);
  const at = id => sources.find(s => s.id === id).text;
  const fact = (id, value, sources) => ({ id, value, sources });
  let facts;
  if (at('s1').includes('staging port')) {
    const old = Number(at('s1').match(/port (\d+)/)[1]), current = Number(at('s2').match(/port (\d+)/)[1]);
    facts = [fact('previous_port', old, ['s1']), fact('current_port', current, ['s2']),
      fact('relationship', { old, current, relation: 'superseded_by' }, ['s1', 's2'])];
  } else if (at('s1').startsWith('Investigate')) {
    facts = [fact('recommended_command', 'dotnet build App.sln', ['s2']), fact('command_executed', false, ['s2']),
      fact('sdk_version', null, ['s3']), fact('read_outcome', 'denied', ['s4']), fact('file_changed', false, ['s2', 's4'])];
  } else {
    const boundary = Number(at('s2').match(/image (\d+)/)[1]), initial = Number(at('s1').match(/radius (\d+)/)[1]),
      current = Number(at('s2').match(/radius to (\d+)/)[1]), target = Number(at('s1').match(/TARGET is (\d+)/)[1]);
    facts = [fact('earlier_method', { first: 2, last: boundary - 1, radius: initial, alpha: 'preserve' }, ['s1', 's2']),
      fact('later_method', { first: boundary, last: 10, radius: current, alpha: 'preserve' }, ['s1', 's2']),
      fact('completed_image', { image: boundary - 1, radius: initial }, ['s3']), fact('target', target, ['s1']),
      fact('version', { verified: false, observed: null }, ['s4'])];
  }
  return { facts, background: [] };
}

async function setup(t, mode = 'normal') {
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks)); requests.push(body);
    if (mode === 'hang') return;
    if (mode === 'error') { res.writeHead(503); res.end('endpoint unavailable'); return; }
    let value = answerFixture(body.messages.at(-1).content);
    if (mode === 'malformed') value = { background: ['[]'] };
    if (mode === 'approve' && value.requirements) value = conclusions(Object.fromEntries(Object.keys(value.requirements).map(k => [k, 'supported'])), []);
    const message = { role: 'assistant', content: mode === 'fence' ? '```json\n' + JSON.stringify(value) + '\n```' : JSON.stringify(value) };
    res.end(JSON.stringify(req.url === '/api/chat' ? { message, done: true, done_reason: mode === 'length' ? 'length' : 'stop' }
      : { choices: [{ message, finish_reason: mode === 'length' ? 'length' : 'stop' }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const directory = await mkdtemp(join(tmpdir(), 'context-evaluator-'));
  const evaluator = new Evaluation(directory); await evaluator.initialize();
  t.after(async () => { await evaluator.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true }); });
  return { evaluator, requests, directory, config: configuration({ kind: 'ollama', model: 'fixture',
    baseUrl: `http://127.0.0.1:${server.address().port}`, repetitions: 1, suite: 'context' }) };
}

for (const kind of ['ollama', 'openai-compatible']) test(`${kind}: context suites retain phases, independent oracles and raw evidence`, async t => {
  const f = await setup(t), id = await f.evaluator.start({ ...f.config, kind });
  await f.evaluator.active.work;
  const report = f.evaluator.reports.get(id);
  assert.equal(report.status, 'completed'); assert.equal(report.trials.length, 11);
  assert.deepEqual(report.trials.map(t => t.status), Array(11).fill('passed'));
  assert.equal(f.requests.length, 17);
  assert.deepEqual(report.trials.find(t => t.caseId === 'context-repeat').assessments.map(a => a.phase), ['generation', 'regeneration', 'use']);
  assert.ok(f.requests.every(r => !r.tools && r.max_tokens === undefined && r.options?.num_predict === undefined));
  assert.equal(report.summary.find(s => s.dimension === 'checking').gradedFaultyCandidates, 4);
  const saved = JSON.parse(await readFile(join(f.directory, `${id}.json`), 'utf8'));
  assert.deepEqual(saved, report);
  const reopened = new Evaluation(f.directory); await reopened.initialize();
  assert.deepEqual(reopened.reports.get(id), report);
  assert.ok(f.evaluator.list()[0].trials.every(t => !t.evidence && !t.oracle && !t.assessments));
});

test('semantic false acceptance, malformed output and incomplete requests are separate', async t => {
  for (const [mode, category] of [['approve', 'semantic_mismatch'], ['malformed', 'invalid_structure'], ['length', 'provider_truncation'], ['error', 'request_error']]) {
    const f = await setup(t, mode), id = await f.evaluator.start({ ...f.config, suite: 'context-checking' });
    await f.evaluator.active.work;
    const report = f.evaluator.reports.get(id);
    if (mode === 'approve') {
      assert.equal(report.trials.filter(t => t.category === category).length, 4);
      assert.equal(report.summary[0].falseAcceptance, 4);
      assert.equal(report.summary[0].falseRejection, 0);
    } else {
      assert.ok(report.trials.every(t => t.category === category));
      assert.ok(report.trials.every(t => t.status === (mode === 'malformed' ? 'failed' : 'inconclusive')));
      assert.equal(report.summary[0].gradedFaultyCandidates, 0);
      if (mode === 'error') assert.ok(report.trials.every(t => t.evidence[0].response.httpStatus === 503));
    }
    assert.equal(f.requests.length, 6, 'No repair/retry can turn an initial failure into a pass.');
  }
});

test('cancelled context requests stop the suite and release execution', async t => {
  const f = await setup(t, 'hang'), id = await f.evaluator.start(f.config), work = f.evaluator.active.work;
  await new Promise(resolve => setTimeout(resolve, 35)); f.evaluator.cancel(id); await work;
  assert.equal(f.evaluator.active, null);
  assert.equal(f.evaluator.reports.get(id).status, 'cancelled');
  assert.equal(f.evaluator.reports.get(id).trials.length, 1);
  assert.equal(f.evaluator.reports.get(id).trials[0].category, 'cancelled');
});

test('a JSON fence is a strict failure, with separately labelled content diagnostics', async t => {
  const f = await setup(t, 'fence'), id = await f.evaluator.start(f.config);
  await f.evaluator.active.work;
  const report = f.evaluator.reports.get(id);
  assert.equal(f.requests.length, 11, 'Do not continue with a noncompliant representation.');
  assert.ok(report.trials.every(t => t.status === 'failed' && t.category === 'invalid_structure'));
  assert.ok(report.trials.every(t => t.assessments[0].contentDiagnostic.passed && t.assessments[0].contentDiagnostic.accepted === false));
  assert.equal(report.summary.find(s => s.dimension === 'checking').gradedFaultyCandidates, 4);
  assert.equal(report.summary.find(s => s.dimension === 'checking').passed, 0);
});

test('suite selection is explicit and incomplete checking is not a clean reliability score', () => {
  assert.equal(selectedCases().length, 6); assert.equal(selectedCases('all').length, 17);
  assert.throws(() => configuration({ kind: 'ollama', baseUrl: 'http://localhost', suite: 'invented' }));
  const summary = summarize([{ dimension: 'checking', candidateClass: 'faulty', status: 'inconclusive', category: 'provider_truncation', assessments: [] }])[0];
  assert.equal(summary.falseAcceptance, 0); assert.equal(summary.gradedFaultyCandidates, 0); assert.equal(summary.inconclusive, 1);
});
