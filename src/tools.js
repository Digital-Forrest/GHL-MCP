/**
 * MCP tool definitions for the GHL proxy.
 *
 * Five generic tools cover 100% of the GHL v2 API surface.
 * The locationId is always injected server-side, so Claude never
 * needs to pass it explicitly.
 */

export const TOOLS = [
  {
    name: 'ghl_get',
    description:
      'Execute a GET request to any GoHighLevel v2 API endpoint. ' +
      'The locationId is automatically injected. ' +
      'Example: path="/contacts/", params={"query":"John"}',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'API path starting with /, e.g. /contacts/ or /conversations/',
        },
        params: {
          type: 'object',
          description: 'Optional query parameters to append to the request URL.',
          additionalProperties: { type: 'string' },
        },
        account: {
          type: 'string',
          description: 'Optional: name of the GHL sub-account to use. Defaults to the active account.',
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'ghl_post',
    description:
      'Execute a POST request to any GoHighLevel v2 API endpoint. ' +
      'Use for creating resources such as contacts, opportunities, or tasks.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'API path starting with /, e.g. /contacts/',
        },
        body: {
          type: 'object',
          description: 'JSON request body.',
        },
        account: {
          type: 'string',
          description: 'Optional: name of the GHL sub-account to use. Defaults to the active account.',
        },
      },
      required: ['path', 'body'],
      additionalProperties: false,
    },
  },
  {
    name: 'ghl_put',
    description:
      'Execute a PUT request to any GoHighLevel v2 API endpoint. ' +
      'Use for full replacement updates.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'API path starting with /, e.g. /contacts/{id}',
        },
        body: {
          type: 'object',
          description: 'JSON request body.',
        },
        account: {
          type: 'string',
          description: 'Optional: name of the GHL sub-account to use. Defaults to the active account.',
        },
      },
      required: ['path', 'body'],
      additionalProperties: false,
    },
  },
  {
    name: 'ghl_patch',
    description:
      'Execute a PATCH request to any GoHighLevel v2 API endpoint. ' +
      'Use for partial updates to an existing resource.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'API path starting with /, e.g. /contacts/{id}',
        },
        body: {
          type: 'object',
          description: 'JSON request body with only the fields to update.',
        },
        account: {
          type: 'string',
          description: 'Optional: name of the GHL sub-account to use. Defaults to the active account.',
        },
      },
      required: ['path', 'body'],
      additionalProperties: false,
    },
  },
  {
    name: 'ghl_delete',
    description:
      'Execute a DELETE request to any GoHighLevel v2 API endpoint. ' +
      'Use for removing resources such as tags, tasks, or notes.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'API path starting with /, e.g. /contacts/{id}/tags/{tagId}',
        },
        account: {
          type: 'string',
          description: 'Optional: name of the GHL sub-account to use. Defaults to the active account.',
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
];

/** Allowed characters in a GHL API path (mirrors sanitizePath in ghl.js). */
const VALID_PATH_RE = /^[a-zA-Z0-9\-_/.~%?=&+:@,[\]]+$/;

/**
 * Validate that all required arguments are present for a given tool,
 * including a lightweight path-safety check so invalid paths are caught
 * as JSON-RPC -32602 (Invalid Params) before they reach the GHL layer.
 *
 * @param {string} toolName
 * @param {object} args
 * @throws {Error} if required arguments are missing or of wrong type
 */
export function validateToolArgs(toolName, args) {
  const tool = TOOLS.find((t) => t.name === toolName);
  if (!tool) {
    throw new Error(`Unknown tool: ${toolName}`);
  }

  const required = tool.inputSchema.required ?? [];
  for (const field of required) {
    if (args[field] === undefined || args[field] === null) {
      throw new Error(`Missing required argument: ${field}`);
    }
  }

  if (args.path !== undefined) {
    if (typeof args.path !== 'string') {
      throw new Error('path must be a string');
    }
    // Eagerly validate path format so callers receive -32602, not -32603
    const clean = args.path.replace(/\.\.\//g, '').replace(/\.\.$/g, '').replace(/\/+/g, '/');
    if (!clean.startsWith('/')) {
      throw new Error('path must start with /');
    }
    if (!VALID_PATH_RE.test(clean)) {
      throw new Error('path contains invalid characters');
    }
  }

  if (args.body !== undefined && (typeof args.body !== 'object' || Array.isArray(args.body))) {
    throw new Error('body must be a plain object');
  }

  if (args.params !== undefined && (typeof args.params !== 'object' || Array.isArray(args.params))) {
    throw new Error('params must be a plain object');
  }
}
