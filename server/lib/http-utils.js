'use strict';

const fs = require('fs');

function sendJson(res, statusCode, body, extraHeaders = {}) {
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'authorization,content-type',
    ...extraHeaders
  });
  res.end(JSON.stringify(body, null, 2) + '\n');
}

function sendHtml(res, statusCode, html) {
  res.writeHead(statusCode, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*'
  });
  res.end(html);
}

function sendText(res, statusCode, text, contentType, fileName = '') {
  const headers = {
    'content-type': contentType,
    'cache-control': 'no-store'
  };
  if (fileName) headers['content-disposition'] = `attachment; filename="${fileName}"`;
  res.writeHead(statusCode, headers);
  res.end(text);
}

function sendFile(res, filePath, contentType) {
  res.writeHead(200, {
    'content-type': contentType,
    'cache-control': 'no-store'
  });
  fs.createReadStream(filePath).pipe(res);
}

function staticContentType(filePath) {
  if (filePath.endsWith('.html')) return 'text/html; charset=utf-8';
  if (filePath.endsWith('.css')) return 'text/css; charset=utf-8';
  if (filePath.endsWith('.js')) return 'application/javascript; charset=utf-8';
  return 'application/octet-stream';
}

function readBody(req, maxBodyBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];

    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBodyBytes) {
        reject(Object.assign(new Error('request_body_too_large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error('invalid_json'), { statusCode: 400 }));
      }
    });

    req.on('error', reject);
  });
}

module.exports = {
  readBody,
  sendFile,
  sendHtml,
  sendJson,
  sendText,
  staticContentType
};
