import { EventEmitter } from 'events';

// Kleine gedeelde event-bus binnen het main-proces. Zo kan ipc-handlers.ts
// laten weten dat de chat-lijst is gewijzigd zonder main.ts te importeren
// (voorkomt een circulaire import).
export const appEvents = new EventEmitter();

export function notifyChatsChanged() {
  appEvents.emit('chats-changed');
}
