'use strict';
// Job bookkeeping helpers for synth-agent (pure, unit-tested in test/jobs.test.js).
//  * listJobs: newest first, limited, always valid JSON (never a sliced string).
//  * compactJob: show_job output with long string fields shortened per field (valid JSON).
//  * madeLine: finish's first line without a doubled full stop.
//  * reconcileJob: on startup, a job still marked queued/running has no waiter (waiting only ever happens inside a
//    tool call, which a restart kills). Ask the Dell for its status first; never cancel anything on the Dell.
const fs = require('fs'), path = require('path');

// dell-media-gateway (:8091) headers, the one place they are built. Every POST carries X-Client: synth-agent so the
// gateway's tests-first gap is skipped for Synth renders (Dell, 12:44:43); GETs (status, downloads) do not need it.
const CLIENT = 'synth-agent';
function gatewayHeaders(key, method, extra = {}) {
  const h = { Authorization: 'Bearer ' + key, ...extra };
  if (String(method).toUpperCase() === 'POST') h['X-Client'] = CLIENT;
  return h;
}

const LIST_DEFAULT = 20, LIST_MAX = 100, FIELD_MAX = 1000, ROW_ERR_MAX = 240;
const clip = (s, n) => (typeof s === 'string' && s.length > n ? s.slice(0, n) + `… (${s.length} chars)` : s);

function listJobs(dir, JOB_RE, limit, label) {
  const n = limit == null ? LIST_DEFAULT : limit;
  if (!(Number.isInteger(n) && n >= 1 && n <= LIST_MAX)) throw new Error(`error list_jobs.limit: must be a whole number 1-${LIST_MAX}, got ${JSON.stringify(limit)}; for example limit:20`);
  if (!fs.existsSync(dir)) return { total: 0, shown: 0, jobs: [] };
  const rows = [];
  for (const id of fs.readdirSync(dir)) {
    const f = path.join(dir, id, 'job.json');
    if (!JOB_RE.test(id) || !fs.existsSync(f)) continue;
    let j;
    try { j = JSON.parse(fs.readFileSync(f, 'utf8')); }
    catch (e) { rows.push({ job_id: id, status: 'unreadable', error: clip(`job.json is not valid JSON: ${e.message}`, ROW_ERR_MAX), created: '' }); continue; }
    rows.push({ job_id: id, kind: j.kind, label: (label && label(j)) || undefined, name: j.name, status: j.status, created: j.created, error: clip(j.error || undefined, ROW_ERR_MAX) });
  }
  rows.sort((a, b) => String(b.created).localeCompare(String(a.created)));
  const out = { total: rows.length, shown: Math.min(n, rows.length), jobs: rows.slice(0, n) };
  if (rows.length > n) out.note = `${rows.length - n} older jobs not shown; show_job reads any job by job_id`;
  return out;
}

function compactJob(j) {
  const o = {};
  for (const [k, v] of Object.entries(j)) o[k] = clip(v, FIELD_MAX);
  return o;
}

function madeLine(what) {
  const w = String(what).replace(/\s+$/, '');
  return /[.!?…]$/.test(w) ? `Made ${w}` : `Made ${w}.`;
}

// deps: { dellStatus(j) -> Promise<st> (throws Error with .status on HTTP errors), saveJob(id, j), resume(id, j), now() }
// Returns a one-line outcome for the log.
async function reconcileJob(id, j, deps) {
  const when = deps.now();
  if (!j.dell_job_id) {
    const was = j.status;
    j.status = 'failed'; j.finished = when;
    j.error = `JOB FAILED: synth-agent restarted while this ${j.kind} job was ${was} on this machine with no Dell job id, so its work was lost (anything already sent to the Dell was not cancelled, but Synth cannot collect it); marked failed at ${when}. Start a new job.`;
    deps.saveJob(id, j);
    return 'failed: no Dell job id, in-process work lost at restart';
  }
  let st;
  try { st = await deps.dellStatus(j); }
  catch (e) {
    if (e.status === 404) {
      j.status = 'failed'; j.finished = when;
      j.error = `JOB FAILED: the Dell no longer has job ${j.dell_job_id} (${e.message}). Nothing in Synth was waiting on it after a restart, so its result was never collected; nothing was cancelled. Start a new job.`;
      deps.saveJob(id, j);
      return `failed: Dell job ${j.dell_job_id} gone (404)`;
    }
    return `RECONCILE FAILED: could not ask the Dell about ${j.dell_job_id}: ${e.message} (left ${j.status}; retried on next start)`;
  }
  deps.resume(id, j);
  return `Dell says ${st.status}; resumed waiting/collecting in the background`;
}

module.exports = { CLIENT, gatewayHeaders, listJobs, compactJob, madeLine, reconcileJob, LIST_DEFAULT, LIST_MAX };
