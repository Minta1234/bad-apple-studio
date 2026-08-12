'use strict';

const express = require('express');
const path = require('path');

const jobsRouter    = require('./src/routes/convert');
const firmwareRouter = require('./src/routes/firmware');

const app = express();

app.use(express.static(path.join(__dirname, '..', 'web')));
app.use('/api/jobs',     jobsRouter);
app.use('/api/firmware', firmwareRouter);

app.use((err, req, res, next) => {
  console.error(err);
  res.status(400).json({ error: err.message || 'Error' });
});

const PORT = 3000;
const HOST = '127.0.0.1'; 

app.listen(PORT, HOST, () => {
  console.log(`Bad Apple Studio: http://${HOST}:${PORT}`);
});
