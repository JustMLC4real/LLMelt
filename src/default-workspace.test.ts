import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WORKSPACE_NAME,
  LEGACY_WORKSPACE_NAME,
  selectDefaultWorkspacePath,
} from '../electron/default-workspace';

describe('standaardwerkmap na de LLMelt-rebrand', () => {
  const documents = path.join('C:', 'Users', 'Test', 'Documents');

  it('kiest Documents\\LLMelt op een nieuwe installatie', () => {
    expect(selectDefaultWorkspacePath(documents, () => false))
      .toBe(path.join(documents, DEFAULT_WORKSPACE_NAME));
  });

  it('behoudt een bestaande legacywerkmap als LLMelt nog niet bestaat', () => {
    const legacy = path.join(documents, LEGACY_WORKSPACE_NAME);
    expect(selectDefaultWorkspacePath(documents, (candidate) => candidate === legacy))
      .toBe(legacy);
  });

  it('geeft de nieuwe LLMelt-map voorrang zodra die bestaat', () => {
    expect(selectDefaultWorkspacePath(documents, () => true))
      .toBe(path.join(documents, DEFAULT_WORKSPACE_NAME));
  });
});
