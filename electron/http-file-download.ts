import fs from 'node:fs';
import path from 'node:path';

export type HttpFileDownloadProgress = {
  transferred: number;
  total: number;
  bytesPerSecond: number;
  percent?: number;
};

type HttpFileDownloadOptions = {
  timeoutMs?: number;
  signal?: AbortSignal;
  onProgress?: (progress: HttpFileDownloadProgress) => void;
};

function contentLength(response: Response) {
  const value = response.headers.get('content-length');
  if (!value || !/^\d+$/.test(value)) return 0;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * Streamt een HTTP-bestand rechtstreeks naar schijf. Zo hoeft een grote
 * installer niet in het geheugen en kan de renderer uitsluitend gemeten
 * bytes, snelheid en (bij Content-Length) een echt percentage tonen.
 */
export async function downloadHttpFile(
  url: string,
  destination: string,
  options: HttpFileDownloadOptions = {},
) {
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) abortFromCaller();
  else options.signal?.addEventListener('abort', abortFromCaller, { once: true });
  const timeout = setTimeout(
    () => controller.abort(new Error('De download duurde te lang.')),
    options.timeoutMs ?? 60 * 60_000,
  );

  let target: fs.promises.FileHandle | null = null;
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': 'LLMelt' },
    });
    if (!response.ok || !response.body) {
      throw new Error(`Download mislukt (${response.status} ${response.statusText}).`);
    }

    const total = contentLength(response);
    await fs.promises.mkdir(path.dirname(destination), { recursive: true });
    target = await fs.promises.open(destination, 'w');
    const reader = response.body.getReader();
    const startedAt = Date.now();
    let transferred = 0;
    let lastReportAt = 0;
    let lastPercent = -1;

    const report = (force = false) => {
      const elapsedSeconds = Math.max(0.001, (Date.now() - startedAt) / 1_000);
      const percent = total > 0
        ? Math.min(100, Math.floor((transferred * 100) / total))
        : undefined;
      const now = Date.now();
      if (
        force
        || percent !== lastPercent
        || now - lastReportAt >= 500
      ) {
        options.onProgress?.({
          transferred,
          total,
          bytesPerSecond: Math.floor(transferred / elapsedSeconds),
          ...(percent === undefined ? {} : { percent }),
        });
        lastReportAt = now;
        lastPercent = percent ?? -1;
      }
    };

    report(true);
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      let offset = 0;
      while (offset < chunk.length) {
        const { bytesWritten } = await target.write(
          chunk,
          offset,
          chunk.length - offset,
          null,
        );
        if (bytesWritten <= 0) throw new Error('De download kon niet verder naar schijf worden geschreven.');
        offset += bytesWritten;
      }
      transferred += chunk.length;
      report();
    }
    await target.sync();

    if (total > 0 && transferred !== total) {
      throw new Error(`Download is onvolledig (${transferred} van ${total} bytes).`);
    }
    report(true);
    return { transferred, total };
  } catch (error) {
    await target?.close().catch(() => { });
    target = null;
    await fs.promises.rm(destination, { force: true }).catch(() => { });
    if (controller.signal.aborted) {
      const reason = controller.signal.reason;
      throw reason instanceof Error ? reason : new Error('De download is afgebroken.');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', abortFromCaller);
    await target?.close().catch(() => { });
  }
}
