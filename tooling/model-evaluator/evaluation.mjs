import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { cases, scenario, suiteRevision, limitations } from './cases.mjs';
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
  list() { return [...this.reports.values()].sort((a,b) => b.startedAt.localeCompare(a.startedAt)).map(({trials, ...r}) => ({ ...r, trials: trials.map(({evidence, ...t}) => t) })); }
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
    const abort = new AbortController();
    const report = { version: 1, id: randomUUID(), suiteRevision, target: safeConfiguration(config), limitations,
      startedAt: new Date().toISOString(), finishedAt: null, status: 'running', total: cases.length * config.repetitions, trials: [] };
    const active = { id: report.id, abort, work: null }; this.active = active;
    try { await this.save(report); } catch(error) { this.active = null; throw error; }
    this.reports.set(report.id, report);
    active.work = this.run(config, report, abort.signal).finally(() => { this.active = null; });
    return report.id;
  }
  async run(config, report, signal) {
    const redact = value => config.apiKey ? JSON.parse(JSON.stringify(value).replaceAll(JSON.stringify(config.apiKey).slice(1,-1), '[redacted]')) : value;
    try {
      for (const spec of cases) for (let repetition = 1; repetition <= config.repetitions; repetition++) {
        if (signal.aborted) break;
        const trial = { caseId: spec.id, title: spec.title, repetition, status: 'inconclusive', reason: '', evidence: [] };
        try {
          const sc = scenario(spec.id);
          const first = await exchange(config, sc.messages, sc.tools, signal, trial.evidence);
          if (first.truncated) trial.reason = 'Provider output was truncated.';
          else if (!sc.check(first)) { trial.status = 'failed'; trial.reason = 'Response did not satisfy the case requirement.'; }
          else if (!sc.followup) { trial.status = 'passed'; }
          else {
            const next = sc.followup();
            const messages = [...sc.messages, first.message, toolReply(config, first.calls[0], next.result)];
            const second = await exchange(config, messages, sc.tools, signal, trial.evidence);
            trial.status = second.truncated ? 'inconclusive' : sc.checkFollowup(second, next) ? 'passed' : 'failed';
            if (trial.status !== 'passed') trial.reason = second.truncated ? 'Provider output was truncated.' : 'Follow-up did not satisfy the case requirement.';
          }
        } catch(error) { trial.reason = signal.aborted ? 'Cancelled.' : String(error.message ?? error); }
        report.trials.push(redact(trial));
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
