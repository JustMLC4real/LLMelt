import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  downloadHttpFile,
  type HttpFileDownloadProgress,
} from '../electron/http-file-download';

const directories: string[] = [];
const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(
    (server) => new Promise<void>((resolve) => server.close(() => resolve())),
  ));
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('HTTP-bestandsdownload', () => {
  it('streamt exacte bytes en meldt echte tussenpercentages en snelheid', async () => {
    const payload = Buffer.alloc(512 * 1024, 0x5a);
    const server = createServer((_request, response) => {
      response.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(payload.length),
      });
      let offset = 0;
      const timer = setInterval(() => {
        const next = payload.subarray(offset, Math.min(payload.length, offset + 32 * 1024));
        if (!next.length) {
          clearInterval(timer);
          response.end();
          return;
        }
        response.write(next);
        offset += next.length;
      }, 2);
      response.once('close', () => clearInterval(timer));
    });
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address() as AddressInfo;
    const directory = mkdtempSync(path.join(tmpdir(), 'ai-superapp-download-'));
    directories.push(directory);
    const destination = path.join(directory, 'payload.bin');
    const progress: HttpFileDownloadProgress[] = [];

    const result = await downloadHttpFile(
      `http://127.0.0.1:${port}/payload.bin`,
      destination,
      { onProgress: (value) => progress.push(value) },
    );

    expect(result).toEqual({ transferred: payload.length, total: payload.length });
    expect(readFileSync(destination)).toEqual(payload);
    expect(progress[0]).toMatchObject({ transferred: 0, total: payload.length, percent: 0 });
    expect(progress.some((value) => (value.percent ?? 0) > 0 && (value.percent ?? 100) < 100)).toBe(true);
    expect(progress.at(-1)).toMatchObject({
      transferred: payload.length,
      total: payload.length,
      percent: 100,
    });
    expect(progress.some((value) => value.bytesPerSecond > 0)).toBe(true);
  });

  it('verwijdert een gedeeltelijk bestand na een afgebroken download', async () => {
    const advertisedSize = 128 * 1024;
    const server = createServer((_request, response) => {
      response.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(advertisedSize),
      });
      response.write(Buffer.alloc(1024, 0x2a));
      response.destroy();
    });
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address() as AddressInfo;
    const directory = mkdtempSync(path.join(tmpdir(), 'ai-superapp-download-fout-'));
    directories.push(directory);
    const destination = path.join(directory, 'onvolledig.bin');

    await expect(downloadHttpFile(
      `http://127.0.0.1:${port}/onvolledig.bin`,
      destination,
    )).rejects.toBeInstanceOf(Error);
    expect(existsSync(destination)).toBe(false);
  });
});
