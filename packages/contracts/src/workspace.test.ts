import { describe, expect, it } from 'vitest';

import { WORKSPACE_HEADER, parseWorkspaceId } from './workspace.ts';

describe('parseWorkspaceId', () => {
  it('accepts word characters, hyphens and underscores up to 64 chars', () => {
    expect(parseWorkspaceId('e2e-workspace_1')).toBe('e2e-workspace_1');
    expect(parseWorkspaceId('a'.repeat(64))).toBe('a'.repeat(64));
  });

  it('rejects malformed header values as null (fallback to the ownerless scope)', () => {
    expect(parseWorkspaceId('')).toBeNull();
    expect(parseWorkspaceId('a'.repeat(65))).toBeNull();
    expect(parseWorkspaceId('has spaces')).toBeNull();
    expect(parseWorkspaceId('../../etc/passwd')).toBeNull();
    expect(parseWorkspaceId('semicolon;drop')).toBeNull();
  });

  it('maps an absent header to null: the ownerless scope', () => {
    expect(parseWorkspaceId(null)).toBeNull();
    expect(parseWorkspaceId(undefined)).toBeNull();
  });

  it('exposes the header name used by api and web readers', () => {
    expect(WORKSPACE_HEADER).toBe('x-workspace-id');
  });
});
