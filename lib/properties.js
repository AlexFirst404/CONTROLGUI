'use strict';

// server.properties: key=value, строки с # — комментарии.

function parse(text) {
  const obj = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 0) continue;
    obj[line.slice(0, i).trim()] = line.slice(i + 1);
  }
  return obj;
}

function stringify(obj) {
  const lines = [
    '#Minecraft server properties',
    '#Managed by CONTROLGUI',
  ];
  for (const key of Object.keys(obj).sort()) {
    // значения не должны содержать переводов строк
    const value = String(obj[key]).replace(/[\r\n]/g, ' ');
    lines.push(key + '=' + value);
  }
  return lines.join('\n') + '\n';
}

module.exports = { parse, stringify };
