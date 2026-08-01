import type {
  IpcMain,
  IpcMainEvent,
  IpcMainInvokeEvent,
  WebContents,
} from 'electron';
import { fileURLToPath } from 'url';
import path from 'path';

type IpcEvent = IpcMainEvent | IpcMainInvokeEvent;
type InvokeListener = (event: IpcMainInvokeEvent, ...args: any[]) => any;
type EventListener = (event: IpcMainEvent, ...args: any[]) => void;

const trustedRenderers = new Map<number, string>();

export function trustRenderer(contents: WebContents, expectedUrl: string) {
  trustedRenderers.set(contents.id, expectedUrl);
  contents.once('destroyed', () => trustedRenderers.delete(contents.id));
}

export function createTrustedIpcMain(ipcMain: IpcMain): IpcMain {
  return new Proxy(ipcMain, {
    get(target, property, receiver) {
      if (property === 'handle') {
        return (channel: string, listener: InvokeListener) => target.handle(channel, (event, ...args) => {
          assertTrustedIpcEvent(event, channel);
          return listener(event, ...args);
        });
      }
      if (property === 'handleOnce') {
        return (channel: string, listener: InvokeListener) => target.handleOnce(channel, (event, ...args) => {
          assertTrustedIpcEvent(event, channel);
          return listener(event, ...args);
        });
      }
      if (property === 'on') {
        return (channel: string, listener: EventListener) => target.on(channel, (event, ...args) => {
          assertTrustedIpcEvent(event, channel);
          listener(event, ...args);
        });
      }

      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

export function isAllowedRendererUrl(actualUrl: string, expectedUrl: string) {
  try {
    const actual = new URL(actualUrl);
    const expected = new URL(expectedUrl);
    if (expected.protocol === 'http:' || expected.protocol === 'https:') {
      return actual.origin === expected.origin;
    }
    if (expected.protocol !== 'file:' || actual.protocol !== 'file:') return false;
    return path.resolve(fileURLToPath(actual)) === path.resolve(fileURLToPath(expected));
  } catch {
    return false;
  }
}

export function isSafeExternalUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' || url.protocol === 'mailto:';
  } catch {
    return false;
  }
}

function assertTrustedIpcEvent(event: IpcEvent, channel: string) {
  const expectedUrl = trustedRenderers.get(event.sender.id);
  const actualUrl = event.senderFrame?.url || event.sender.getURL();
  if (!expectedUrl || !isAllowedRendererUrl(actualUrl, expectedUrl)) {
    throw new Error(`Niet-vertrouwde IPC-aanroep geweigerd: ${channel}`);
  }
}
