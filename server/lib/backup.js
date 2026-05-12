'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function safeFileStamp(nowIso) {
  return nowIso().replace(/[:.]/g, '-');
}

async function sendSqliteBackup({ res, store, nowIso }) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'safeharbor-backup-'));
  const backupFile = path.join(tempDir, `safeharbor-backup-${safeFileStamp(nowIso)}.sqlite`);
  try {
    await store.backupTo(backupFile);
    await streamBackup(res, backupFile);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function streamBackup(res, backupFile) {
  return new Promise((resolve, reject) => {
    const stream = fs.createReadStream(backupFile);
    let settled = false;

    function finish(error) {
      if (settled) return;
      settled = true;
      if (error) {
        reject(error);
        return;
      }
      resolve();
    }

    res.on('close', () => {
      stream.destroy();
    });
    stream.on('error', finish);
    stream.on('end', finish);
    stream.on('close', () => finish());

    res.writeHead(200, {
      'content-type': 'application/vnd.sqlite3',
      'cache-control': 'no-store',
      'content-disposition': 'attachment; filename="safeharbor-backup.sqlite"'
    });
    stream.pipe(res);

    res.on('finish', () => finish());
  });
}

module.exports = {
  sendSqliteBackup,
  streamBackup
};
