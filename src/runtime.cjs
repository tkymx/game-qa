'use strict';
// Writes live status (status.json), recent decisions (feed.json) and the full log (*.jsonl)
// into runtimeDir. The macOS monitor app polls this directory every second.
const fs = require('fs');
const path = require('path');

const FEED_MAX = 60;

function createRuntime(dir, prefix) {
  fs.mkdirSync(dir, { recursive: true });
  const statusPath = path.join(dir, 'status.json');
  const feedPath = path.join(dir, 'feed.json');
  const sessionId = new Date().toISOString().replace(/[:.]/g, '-');
  const logPath = path.join(dir, `${prefix}-${sessionId}.jsonl`);
  const feed = [];

  const atomicWrite = (p, text) => {
    fs.writeFileSync(p + '.tmp', text);
    fs.renameSync(p + '.tmp', p);
  };

  return {
    sessionId,
    logPath,
    status(obj) { atomicWrite(statusPath, JSON.stringify({ sessionId, ...obj, updatedAt: new Date().toISOString() }, null, 2)); },
    log(obj) { fs.appendFileSync(logPath, JSON.stringify(obj) + '\n'); },
    feed(item) {
      feed.push(item);
      if (feed.length > FEED_MAX) feed.shift();
      atomicWrite(feedPath, JSON.stringify(feed));
    },
  };
}

module.exports = { createRuntime };
