import { describe, it, expect } from 'vitest';
import { TOOLS, validateToolArgs } from '../src/tools.js';

// ── Tool definitions ──────────────────────────────────────────────────────────

describe('TOOLS array', () => {
  const expectedNames = ['ghl_get', 'ghl_post', 'ghl_put', 'ghl_patch', 'ghl_delete'];

  it('exports exactly 5 tools', () => {
    expect(TOOLS).toHaveLength(5);
  });

  it('contains all expected tool names', () => {
    const names = TOOLS.map((t) => t.name);
    expect(names).toEqual(expectedNames);
  });

  it.each(TOOLS)('$name has a non-empty description', (tool) => {
    expect(tool.description).toBeTruthy();
    expect(typeof tool.description).toBe('string');
  });

  it.each(TOOLS)('$name has a valid inputSchema with type=object', (tool) => {
    expect(tool.inputSchema.type).toBe('object');
    expect(tool.inputSchema.properties).toBeTruthy();
  });

  it.each(TOOLS)('$name requires path', (tool) => {
    expect(tool.inputSchema.required).toContain('path');
  });

  it('ghl_get does not require body', () => {
    const tool = TOOLS.find((t) => t.name === 'ghl_get');
    expect(tool.inputSchema.required).not.toContain('body');
  });

  it.each(['ghl_post', 'ghl_put', 'ghl_patch'])('%s requires body', (name) => {
    const tool = TOOLS.find((t) => t.name === name);
    expect(tool.inputSchema.required).toContain('body');
  });

  it('ghl_delete does not require body', () => {
    const tool = TOOLS.find((t) => t.name === 'ghl_delete');
    expect(tool.inputSchema.required).not.toContain('body');
  });

  // ── account parameter ────────────────────────────────────────────────────────

  it.each(TOOLS)('$name has an optional account property in inputSchema', (tool) => {
    expect(tool.inputSchema.properties.account).toBeDefined();
    expect(tool.inputSchema.properties.account.type).toBe('string');
  });

  it.each(TOOLS)('$name does not require account', (tool) => {
    expect(tool.inputSchema.required ?? []).not.toContain('account');
  });
});

// ── validateToolArgs ──────────────────────────────────────────────────────────

describe('validateToolArgs', () => {
  it('passes for ghl_get with a valid path', () => {
    expect(() => validateToolArgs('ghl_get', { path: '/contacts/' })).not.toThrow();
  });

  it('passes for ghl_post with path and body', () => {
    expect(() =>
      validateToolArgs('ghl_post', { path: '/contacts/', body: { firstName: 'Jane' } })
    ).not.toThrow();
  });

  it('passes for ghl_delete with just path', () => {
    expect(() => validateToolArgs('ghl_delete', { path: '/contacts/123' })).not.toThrow();
  });

  it('passes when optional account parameter is provided', () => {
    expect(() =>
      validateToolArgs('ghl_get', { path: '/contacts/', account: 'my-account' })
    ).not.toThrow();
  });

  it('throws for an unknown tool name', () => {
    expect(() => validateToolArgs('ghl_unknown', { path: '/' })).toThrow('Unknown tool');
  });

  it('throws when path is missing for ghl_get', () => {
    expect(() => validateToolArgs('ghl_get', {})).toThrow('Missing required argument: path');
  });

  it('throws when body is missing for ghl_post', () => {
    expect(() => validateToolArgs('ghl_post', { path: '/contacts/' })).toThrow(
      'Missing required argument: body'
    );
  });

  it('throws when path is not a string', () => {
    expect(() => validateToolArgs('ghl_get', { path: 42 })).toThrow('path must be a string');
  });

  it('throws when body is an array (not a plain object)', () => {
    expect(() =>
      validateToolArgs('ghl_post', { path: '/contacts/', body: [1, 2, 3] })
    ).toThrow('body must be a plain object');
  });

  it('throws when params is an array (not a plain object)', () => {
    expect(() =>
      validateToolArgs('ghl_get', { path: '/contacts/', params: ['a', 'b'] })
    ).toThrow('params must be a plain object');
  });

  it('accepts optional params as a plain object for ghl_get', () => {
    expect(() =>
      validateToolArgs('ghl_get', { path: '/contacts/', params: { query: 'John' } })
    ).not.toThrow();
  });
});
