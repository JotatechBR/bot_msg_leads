import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

// The panel and the CLI must never own the same sessions/history simultaneously.
export function acquireProjectLock(root) {
  const file = path.join(root, '.orbita', 'runtime.lock');
  const token = randomUUID();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.writeFileSync(file, JSON.stringify({ pid: process.pid, token }), { flag: 'wx', mode: 0o600 });
      return () => {
        if (readJson(file, null)?.token === token) fs.unlinkSync(file);
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let owner;
      try { owner = readJson(file, null); }
      catch { throw Object.assign(new Error('O arquivo de execução está ilegível. Verifique se outro bot está em execução antes de corrigir .orbita/runtime.lock.'), { status: 409 }); }
      let alive = true;
      try { if (!Number.isInteger(owner?.pid) || owner.pid <= 0) throw new Error('invalid pid'); process.kill(owner.pid, 0); }
      catch (error) { alive = error.code === 'EPERM'; }
      if (alive) throw Object.assign(new Error(`O bot já está em uso por outro processo (PID ${owner.pid}). Encerre essa execução antes de conectar ou iniciar pelo painel.`), { status: 409 });
      try { fs.unlinkSync(file); } catch (unlinkError) { if (unlinkError.code !== 'ENOENT') throw unlinkError; }
    }
  }
  throw Object.assign(new Error('Não foi possível reservar a execução. Tente novamente.'), { status: 409 });
}
