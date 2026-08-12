'use strict';

// เก็บ state ของแต่ละ job ใน memory — พอสำหรับ tool รันเครื่องเดียว local
// ถ้าจะขยายเป็น multi-process/production ค่อยย้ายไป Redis หรือไฟล์ + lock

const jobs = new Map();

function createJob(id) {
  const job = {
    id,
    status: 'queued', // queued -> extracting -> packing -> building -> done | error
    progress: '',
    error: null,
    createdAt: Date.now(),
    outputFiles: null, // { bootloader, partitions, firmware, spiffs }
  };
  jobs.set(id, job);
  return job;
}

function updateJob(id, patch) {
  const job = jobs.get(id);
  if (!job) return null;
  Object.assign(job, patch);
  return job;
}

function getJob(id) {
  return jobs.get(id) || null;
}

module.exports = { createJob, updateJob, getJob };
