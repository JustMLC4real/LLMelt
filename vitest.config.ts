import { defineConfig } from 'vitest/config';

// Isolated test config — does NOT load the electron build plugins from vite.config.ts.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: [
        'src/components/*-utils.ts',
        'src/components/agent-commands.ts',
        'src/components/chatgpt-diagnostics.ts',
        'src/components/mcp-tools.ts',
        'src/components/model-utils.ts',
        'electron/ipc-security.ts',
        'electron/path-security.ts',
        'electron/claude-stream.ts',
        'electron/settings-security.ts',
        'electron/gemini-api-native.ts',
        'electron/ollama-native.ts',
      ],
      thresholds: {
        lines: 60,
        functions: 60,
        statements: 60,
        branches: 50,
      },
    },
  },
});
