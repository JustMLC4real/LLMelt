import { describe, expect, it } from 'vitest';
import { pathToFileURL } from 'url';
import path from 'path';
import { isAllowedRendererUrl, isSafeExternalUrl } from '../electron/ipc-security';

describe('IPC renderergrenzen', () => {
  it('staat alleen dezelfde development-origin toe', () => {
    expect(isAllowedRendererUrl('http://localhost:5173/chat#x', 'http://localhost:5173/')).toBe(true);
    expect(isAllowedRendererUrl('https://example.com/', 'http://localhost:5173/')).toBe(false);
    expect(isAllowedRendererUrl('http://localhost.evil.test:5173/', 'http://localhost:5173/')).toBe(false);
  });

  it('staat voor file alleen exact dezelfde rendererfile toe', () => {
    const renderer = pathToFileURL(path.resolve('dist/index.html')).toString();
    const other = pathToFileURL(path.resolve('dist/other.html')).toString();
    expect(isAllowedRendererUrl(`${renderer}#settings`, renderer)).toBe(true);
    expect(isAllowedRendererUrl(other, renderer)).toBe(false);
  });

  it('weigert uitvoerbare en lokale linkprotocollen', () => {
    expect(isSafeExternalUrl('https://example.com/docs')).toBe(true);
    expect(isSafeExternalUrl('mailto:test@example.com')).toBe(true);
    expect(isSafeExternalUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeExternalUrl('file:///C:/Windows/System32/cmd.exe')).toBe(false);
    expect(isSafeExternalUrl('data:text/html,test')).toBe(false);
  });
});
