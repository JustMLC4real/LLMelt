import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

interface ProfileState {
  userAvatarDataUrl: string | null;
  setUserAvatarDataUrl: (value: string | null) => void;
}

export const useProfileStore = create<ProfileState>()(persist((set) => ({
  userAvatarDataUrl: null,
  setUserAvatarDataUrl: (value) => set({ userAvatarDataUrl: value }),
}), {
  name: 'superapp-profile',
  storage: createJSONStorage(() => localStorage),
}));
