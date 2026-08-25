'use strict';

const fs   = require('fs');
const path = require('path');

const JOBS_ROOT = path.join(__dirname, '..', '..', 'jobs');

// In-memory cache — populated at startup by scanning the jobs directory
// and on every createJob/updateJob call.
const jobs = new Map();

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
  };
  jobs.set(id, job);
  _persist(job);
  return job;
}

function updateJob(id, patch) {
  let job = jobs.get(id);
  if (!job) return null;
  Object.assign(job, patch);
  _persist(job);
  return job;
}

function getJob(id) {
  return jobs.get(id) || _loadFromDisk(id);
}

module.exports = { createJob, updateJob, getJob };
