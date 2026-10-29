import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { selectedCases, scenario, suiteRevision, limitations } from './cases.mjs';
import { safeConfiguration, exchange, toolReply } from './connection.mjs';

export class Evaluation {
  active = null;
  reports = new Map();
  constructor(directory) { this.directory = directory; }
  async initialize() {
    await mkdir(this.directory, { recursive: true });
    const names = (await readdir(this.directory)).filter(n => /^[a-f0-9-]{36}\.json$/.test(n));
    if (names.length > 100) throw Error('Too many retained reports. Archive older reports before starting.');
    for (const name of names) {
      const path = join(this.directory, name);
      if ((await stat(path)).size > 32 * 1024 * 1024) throw Error('Retained report exceeds the size limit.');
      const bytes = await readFile(path);
      if (bytes.length > 32 * 1024 * 1024) throw Error('Retained report exceeds the size limit.');
      const report = JSON.parse(bytes.toString('utf8'));
      if (report.version !== 1 || `${report.id}.json` !== name || !Array.isArray(report.trials)) throw Error('Invalid retained report.');
      if (report.status === 'running') { report.status = 'interrupted'; await this.save(report); }
      this.reports.set(report.id, report);
    }
  }
  list() { return [...this.reports.values()].sort((a,b) => b.startedAt.localeCompare(a.startedAt)).map(({trials, ...r}) => ({ ...r, trials: trials.map(({evidence, oracle, assessments, ...t}) => t) })); }
  async save(report) {
    const data = JSON.stringify(report, null, 2);
    if (Buffer.byteLength(data) > 32 * 1024 * 1024) throw Error('Report evidence limit reached.');
    const final = join(this.directory, `${report.id}.json`), temporary = `${final}.tmp`;
    await writeFile(temporary, data, { mode: 0o600 }); await rename(temporary, final);
  }
  async start(config) {
    if (this.active) throw Error('An evaluation is already running.');
    if (!config.model) throw Error('Select a model.');
    if (this.reports.size >= 100) throw Error('Report storage is full. Delete or archive an older report.');
    const specs = selectedCases(config.suite);
    const abort = new AbortController();
    const report = { version: 1, id: randomUUID(), suiteRevision, target: safeConfiguration(config), limitations,
      startedAt: new Date().toISOString(), finishedAt: null, status: 'running', total: specs.length * config.repetitions, trials: [], summary: [] };
    const active = { id: report.id, abort, work: null }; this.active = active;
    try { await this.save(report); } catch(error) { this.active = null; throw error; }
    this.reports.set(report.id, report);
    active.work = this.run(config, report, abort.signal).finally(() => { this.active = null; });
    return report.id;
  }
  async run(config, report, signal) {
    const redact = value => config.apiKey ? JSON.parse(JSON.stringify(value).replaceAll(JSON.stringify(config.apiKey).slice(1,-1), '[redacted]')) : value;
    try {
      for (const spec of selectedCases(config.suite)) for (let repetition = 1; repetition <= config.repetitions; repetition++) {
        if (signal.aborted) break;
        const trial = { caseId: spec.id, title: spec.title, dimension: spec.dimension, candidateClass: spec.candidateClass ?? null,
          repetition, status: 'inconclusive', category: null, reason: '', evidence: [], assessments: [] };
        try {
          const sc = scenario(spec.id);
          if (sc.assess) {
            trial.oracle = sc.oracle;
            await evaluateContextTrial(config, sc, trial, signal);
          } else {
            const first = await exchange(config, sc.messages, sc.tools, signal, trial.evidence);
            if (first.truncated) { trial.reason = 'Provider output was truncated.'; trial.category = 'provider_truncation'; }
            else if (!sc.check(first)) { trial.status = 'failed'; trial.reason = 'Response did not satisfy the case requirement.'; }
            else if (!sc.followup) { trial.status = 'passed'; }
            else {
              const next = sc.followup();
              const messages = [...sc.messages, first.message, toolReply(config, first.calls[0], next.result)];
              const second = await exchange(config, messages, sc.tools, signal, trial.evidence);
              trial.status = second.truncated ? 'inconclusive' : sc.checkFollowup(second, next) ? 'passed' : 'failed';
              if (trial.status !== 'passed') trial.reason = second.truncated ? 'Provider output was truncated.' : 'Follow-up did not satisfy the case requirement.';
              if (second.truncated) trial.category = 'provider_truncation';
            }
            trial.category ??= trial.status === 'passed' ? 'passed' : 'requirement_mismatch';
          }
        } catch(error) { trial.category = signal.aborted ? 'cancelled' : 'request_error'; trial.reason = signal.aborted ? 'Cancelled.' : String(error.message ?? error); }
        report.trials.push(redact(trial));
        report.summary = summarize(report.trials);
        await this.save(report);
      }
      report.status = signal.aborted ? 'cancelled' : 'completed';
    } catch(error) { report.status = 'interrupted'; report.error = redact(String(error.message ?? error)); }
    report.finishedAt = new Date().toISOString();
    try { await this.save(report); } catch { report.error = 'Report could not be fully persisted. Evidence may be incomplete.'; }
  }
  cancel(id) { if (this.active?.id !== id) throw Error('Evaluation is not running.'); this.active.abort.abort(); }
  async delete(id) { if (this.active?.id === id) throw Error('Cancel and wait before deleting.');
    if (!this.reports.has(id)) throw Error('Unknown report.');
    await rm(join(this.directory, `${id}.json`)); this.reports.delete(id); }
  async close() { this.active?.abort.abort(); await this.active?.work; }
}

async function evaluateContextTrial(config, scenario, trial, signal) {
  let step = scenario;
  // Fixed finite scenarios, no retries or repairs that could hide the first failure.
  for (let index = 0; step && index < 3; index++) {
    const evidenceIndex = trial.evidence.length;
    const turn = await exchange(config, step.messages, step.tools, signal, trial.evidence);
    if (turn.truncated) {
      trial.category = 'provider_truncation'; trial.reason = `Provider output was truncated during ${step.phase}.`;
      return;
    }
    const assessment = step.assess(turn);
    const recorded = { phase: step.phase, evidenceIndex, ...assessment };
    // Inspect one unambiguous JSON fence for diagnostics without accepting it or
    // continuing the scenario with a response that violated the actual protocol.
    if (assessment.category === 'invalid_structure' && !turn.calls.length && typeof turn.text === 'string') {
      const fence = /^\s*```(?:json)?\s*\n([\s\S]*?)\n```\s*$/i.exec(turn.text);
      if (fence && !fence[1].includes('```')) {
        const content = step.assess({ ...turn, text: fence[1] });
        if (content.category !== 'invalid_structure') recorded.contentDiagnostic = {
          ...content, extraction: 'single_json_code_fence', accepted: false,
        };
      }
    }
    trial.assessments.push(recorded);
    if (!assessment.passed) {
      trial.status = 'failed'; trial.category = assessment.category; trial.reason = assessment.reason;
      return;
    }
    step = scenario.continueWith?.(turn, step.phase) ?? null;
  }
  if (step) throw Error('Evaluation scenario exceeded its fixed step bound.');
  trial.status = 'passed'; trial.category = 'passed';
}

export function summarize(trials) {
  return [...new Set(trials.map(t => t.dimension ?? 'baseline'))].map(dimension => {
    const group = trials.filter(t => (t.dimension ?? 'baseline') === dimension);
    const assessments = group.flatMap(t => t.assessments ?? []).map(a => a.contentDiagnostic ?? a);
    const graded = t => (t.assessments ?? []).some(a => (a.contentDiagnostic ?? a).falseAcceptance !== undefined);
    return { dimension, trials: group.length, passed: group.filter(t => t.status === 'passed').length,
      failed: group.filter(t => t.status === 'failed').length, inconclusive: group.filter(t => t.status === 'inconclusive').length,
      invalidStructure: group.filter(t => t.category === 'invalid_structure').length,
      diagnosticOnlyTrials: group.filter(t => t.assessments?.some(a => a.contentDiagnostic)).length,
      ...(dimension === 'checking' ? {
        faultyCandidates: group.filter(t => t.candidateClass === 'faulty').length,
        faithfulCandidates: group.filter(t => t.candidateClass === 'faithful').length,
        gradedFaultyCandidates: group.filter(t => t.candidateClass === 'faulty' && graded(t)).length,
        gradedFaithfulCandidates: group.filter(t => t.candidateClass === 'faithful' && graded(t)).length,
        falseAcceptance: assessments.filter(a => a.falseAcceptance).length,
        falseRejection: assessments.filter(a => a.falseRejection).length,
        unknownJudgments: assessments.filter(a => a.unknownJudgment).length,
      } : {}) };
  });
}
