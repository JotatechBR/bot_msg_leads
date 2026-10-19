import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { styleText } from 'node:util';

const clock = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' });
const colors = { info: 'cyan', success: 'green', warn: 'yellow', error: 'red' };

export function createLogger({ root, output = (line) => console.log(line), persist = true } = {}) {
  const events = new EventEmitter();
  const entries = [];
  let sequence = 0;
  function log(level, scope, message) {
    const date = new Date();
    scope = String(scope).replace(/[\r\n\x1b]/g, ' ').slice(0, 100);
    const clean = String(message).replace(/[\r\n\x1b]/g, ' ').slice(0, 1200);
    const entry = { id: ++sequence, time: date.toISOString(), level, scope, message: clean };
    entries.push(entry);
    if (entries.length > 300) entries.shift();
    const label = level.toUpperCase().padEnd(7);
    const line = `${clock.format(date)}  ${label}  [${scope}]  ${clean}`;
    output(process.stdout.isTTY ? line.replace(label, styleText(colors[level] ?? 'white', label)) : line);
    if (persist && root) {
      try {
        const directory = path.join(root, '.orbita', 'logs');
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
        fs.appendFileSync(path.join(directory, `${day.format(date)}.log`), line + '\n', { mode: 0o600 });
      } catch (error) { output(`[LOG] Não foi possível gravar o arquivo de log: ${error.message}`); }
    }
    events.emit('entry', entry);
    return entry;
  }
  return { entries, events, log, info: (scope, text) => log('info', scope, text), success: (scope, text) => log('success', scope, text), warn: (scope, text) => log('warn', scope, text), error: (scope, text) => log('error', scope, text) };
}
