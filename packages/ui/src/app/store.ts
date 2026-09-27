import { create } from 'zustand';

interface UiState {
  selectedProjectId?: string;
  sidebarCollapsed: boolean;
  theme: 'system' | 'light' | 'dark';
  selectProject: (projectId: string) => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setTheme: (theme: UiState['theme']) => void;
}

export const useUiStore = create<UiState>((set) => ({
  sidebarCollapsed: false,
  theme: 'system',
  selectProject: (selectedProjectId) => set({ selectedProjectId }),
  setSidebarCollapsed: (sidebarCollapsed) => set({ sidebarCollapsed }),
  setTheme: (theme) => set({ theme }),
}));
