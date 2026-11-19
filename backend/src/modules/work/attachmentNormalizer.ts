import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { ReviewError } from '../governance/reviews';
export const MAX_MATERIAL_BYTES = 5 * 1024 * 1024;
let active = false;
export function materialFormat(body: unknown, type: string): 'image' | 'pdf' {
  if (!Buffer.isBuffer(body) || !body.length || body.length > MAX_MATERIAL_BYTES)
    throw new ReviewError(400, 'INVALID_MATERIAL_FILE');
  if (type === 'application/pdf' && body.subarray(0, 5).toString() === '%PDF-') return 'pdf';
  if (
    type === 'image/png' &&
    body.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return 'image';
  if (type === 'image/jpeg' && body[0] === 255 && body[1] === 216 && body[2] === 255)
    return 'image';
  throw new ReviewError(400, 'INVALID_MATERIAL_FILE');
}
/** Process isolation and bounds, not an OS sandbox or antivirus verdict. */
export async function normalizeMaterial(body: Buffer, format: 'image' | 'pdf'): Promise<Buffer> {
  if (active) throw new ReviewError(503, 'MATERIAL_PROCESSOR_BUSY');
  active = true;
  try {
    const worker = [
      resolve(dirname(process.argv[1] ?? '.'), 'attachment-worker.mjs'),
      resolve('backend/src/modules/work/attachment-worker.mjs'),
      resolve('src/modules/work/attachment-worker.mjs'),
    ].find(existsSync);
    if (!worker) throw new ReviewError(503, 'MATERIAL_PROCESSOR_UNAVAILABLE');
    return await new Promise<Buffer>((accept, reject) => {
      const child = spawn(
        process.execPath,
        [
          '--max-old-space-size=192',
          '--disallow-code-generation-from-strings',
          '--disable-proto=throw',
          worker,
          format,
        ],
        {
          windowsHide: true,
          env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH },
          stdio: ['pipe', 'pipe', 'ignore'],
        }
      );
      const chunks: Buffer[] = [];
      let size = 0,
        failed = false;
      const timer = setTimeout(() => {
        failed = true;
        child.kill();
      }, 20000);
      child.stdout.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_MATERIAL_BYTES) {
          failed = true;
          child.kill();
        } else chunks.push(chunk);
      });
      child.stdin.on('error', () => {
        failed = true;
      });
      child.on('error', () => {
        clearTimeout(timer);
        reject(new ReviewError(503, 'MATERIAL_PROCESSOR_UNAVAILABLE'));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0 || failed || !size) reject(new ReviewError(400, 'INVALID_MATERIAL_FILE'));
        else accept(Buffer.concat(chunks));
      });
      child.stdin.end(body);
    });
  } finally {
    active = false;
  }
}
