import { create } from 'zustand';
import type { UpdateStatus } from '../update-status';

export type { UpdateStatus } from '../update-status';

interface UpdateState {
  status: UpdateStatus;
  currentVersion: string;
  setStatus: (status: UpdateStatus) => void;
  setCurrentVersion: (version: string) => void;
}

export const useUpdateStore = create<UpdateState>((set) => ({
  status: { state: 'idle' },
  currentVersion: '',
  setStatus: (status) => set({ status }),
  setCurrentVersion: (currentVersion) => set({ currentVersion }),
}));

// Is er iets waar de gebruiker aandacht aan moet geven (badge in de sidebar)?
export function updateNeedsAttention(state: string) {
  return state === 'available'
    || state === 'downloading'
    || state === 'downloaded'
    || state === 'installing'
    || state === 'error';
}
