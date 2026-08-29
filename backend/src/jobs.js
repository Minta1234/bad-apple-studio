'use strict';

const fs   = require('fs');
const path = require('path');

const JOBS_ROOT = path.join(__dirname, '..', '..', 'jobs');

// In-memory cache — populated at startup by scanning the jobs directory
// and on every createJob/updateJob call.
const jobs = new Map();
const MAX_LOG_LINES = 500;

function addLog(job, message) {
  if (!message) return;
  job.logs ||= [];
  job.logs.push({ at: Date.now(), message: String(message) });
  if (job.logs.length > MAX_LOG_LINES) job.logs.splice(0, job.logs.length - MAX_LOG_LINES);
}

// Persist job state to <JOBS_ROOT>/<id>/job.json so it survives restarts.
function _persist(job) {
  try {
    const dir = path.join(JOBS_ROOT, job.id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify(job), 'utf8');
  } catch (_) { /* best-effort */ }
}

// Load a job from disk if not in the in-memory cache.
function _loadFromDisk(id) {
  try {
    const raw = fs.readFileSync(path.join(JOBS_ROOT, id, 'job.json'), 'utf8');
    const job = JSON.parse(raw);
    jobs.set(id, job);
    return job;
  } catch (_) {
    return null;
  }
}

function createJob(id) {
  const job = {
    id,
    status:      'queued',
    progress:    '',
    error:       null,
    createdAt:   Date.now(),
    outputFiles: null,
    logs:        [],
  };
  addLog(job, 'Job created — waiting to start.');
  jobs.set(id, job);
  _persist(job);
  return job;
}

function updateJob(id, patch) {
  let job = jobs.get(id);
  if (!job) return null;
  // Keep a concise timeline even for callers which only report progress.
  if (patch.status && patch.status !== job.status) addLog(job, `Stage: ${patch.status}`);
  if (patch.progress && patch.progress !== job.progress) addLog(job, patch.progress);
  if (patch.error && patch.error !== job.error) addLog(job, `Error: ${patch.error}`);
  Object.assign(job, patch);
  _persist(job);
  return job;
}

function appendJobLog(id, message) {
  const job = jobs.get(id);
  if (!job) return null;
  addLog(job, message);
  _persist(job);
  return job;
}

function getJob(id) {
  return jobs.get(id) || _loadFromDisk(id);
}

module.exports = { createJob, updateJob, appendJobLog, getJob };
