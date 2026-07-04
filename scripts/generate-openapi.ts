/**
 * Generate an OpenAPI 3.0.3 spec from Express router definitions.
 *
 * Scans backend/src/routes/*.ts for router.get/post/patch/delete/put calls,
 * converts path parameters, and emits a basic spec with path parameters,
 * request bodies, and response schemas.
 */
import * as fs from 'fs';
import * as path from 'path';

const repoRoot = path.resolve(__dirname, '..');
const routesDir = path.join(repoRoot, 'backend', 'src', 'routes');
const outputPath = path.join(repoRoot, 'openapi.yaml');

type HttpMethod = 'get' | 'post' | 'patch' | 'delete' | 'put';

interface RouteInfo {
  method: HttpMethod;
  expressPath: string;
  openApiPath: string;
  fileName: string;
  tag: string;
  summary: string;
  bodyProps: string[];
  queryProps: string[];
}

const HTTP_METHODS: HttpMethod[] = ['get', 'post', 'patch', 'delete', 'put'];

function fileTag(fileName: string): string {
  const base = fileName.replace(/\.routes\.ts$/, '').replace(/\.utils\.ts$/, '');
  const map: Record<string, string> = {
    orchestrations: 'Autonomous Loop',
    versioning: 'Versioning',
    health: 'Health',
    agents: 'Agents',
    auth: 'Auth',
    projects: 'Projects',
    sessions: 'Sessions',
    events: 'Events',
    gates: 'Gates',
    incidents: 'Incidents',
    mcp: 'MCP',
    'notification-metrics': 'Notification Metrics',
    'project-packages': 'Project Packages',
    'project-releases': 'Project Releases',
    'project-security': 'Security',
    'project-space': 'Project Space',
    'project-space-frozen': 'Project Space',
    users: 'Users',
    wiki: 'Wiki',
    'work-saved-queries': 'Work Saved Queries',
    'agent-inbox': 'Agent Inbox',
    'collaboration-requests': 'Collaboration Requests',
    debug: 'Debug',
    'reward-preview': 'Reward Preview',
  };
  return map[base] ?? base.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function operationId(method: string, openApiPath: string): string {
  const clean = openApiPath
    .replace(/\/v1\//g, '')
    .replace(/[{}]/g, '')
    .replace(/\//g, '_')
    .replace(/^_+/, '')
    .replace(/_+$/, '');
  return `${method}_${clean}`;
}

function extractRoutesFromFile(filePath: string): RouteInfo[] {
  const fileName = path.basename(filePath);
  const content = fs.readFileSync(filePath, 'utf8');
  const routes: RouteInfo[] = [];

  const methodPattern = HTTP_METHODS.map((m) => `(?:${m})`).join('|');
  const routeRegex = new RegExp(
    `router\\.(${methodPattern})\\s*\\(\\s*['\"\\`]([^'\"\\`]+)['\"\\"]`,
    'g',
  );

  const matches: Array<{ method: HttpMethod; expressPath: string; index: number; end: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = routeRegex.exec(content)) !== null) {
    matches.push({
      method: m[1] as HttpMethod,
      expressPath: m[2],
      index: m.index,
      end: m.index + m[0].length,
    });
  }

  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    const blockStart = match.end;
    const blockEnd = matches[i + 1] ? matches[i + 1].index : content.length;
    const block = content.slice(blockStart, blockEnd);

    const openApiPath = match.expressPath.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, '{$1}');

    const bodyProps = new Set<string>();
    const queryProps = new Set<string>();

    let bodyM: RegExpExecArray | null;
    const bodyRegex = /req\.body\.([a-zA-Z_][a-zA-Z0-9_]*)/g;
    while ((bodyM = bodyRegex.exec(block)) !== null) {
      bodyProps.add(bodyM[1]);
    }

    let queryM: RegExpExecArray | null;
    const queryRegex = /req\.query\.([a-zA-Z_][a-zA-Z0-9_]*)/g;
    while ((queryM = queryRegex.exec(block)) !== null) {
      queryProps.add(queryM[1]);
    }

    // Look for a JSDoc comment immediately before this route.
    const preceding = content.slice(i > 0 ? matches[i - 1].end : 0, match.index);
    const jsdocMatch = preceding.match(/\/\*\*([\s\S]*?)\*\//);
    let summary = `${match.method.toUpperCase()} ${openApiPath}`;
    if (jsdocMatch) {
      const desc = jsdocMatch[1]
        .split('\n')
        .map((line) => line.replace(/^\s*\*\s?/, '').trim())
        .filter((line) => line.length > 0 && !line.startsWith('@'))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (desc) {
        summary = desc.slice(0, 120);
      }
    }

    routes.push({
      method: match.method,
      expressPath: match.expressPath,
      openApiPath,
      fileName,
      tag: fileTag(fileName),
      summary,
      bodyProps: Array.from(bodyProps),
      queryProps: Array.from(queryProps),
    });
  }

  return routes;
}

function collectRoutes(): RouteInfo[] {
  const files = fs
    .readdirSync(routesDir)
    .filter((f) => f.endsWith('.routes.ts'))
    .map((f) => path.join(routesDir, f))
    .sort();

  const all: RouteInfo[] = [];
  for (const file of files) {
    all.push(...extractRoutesFromFile(file));
  }
  return all;
}

function pathParameters(openApiPath: string): Array<{ name: string; in: 'path'; required: true; schema: { type: string } }> {
  const params: Array<{ name: string; in: 'path'; required: true; schema: { type: string } }> = [];
  const regex = /\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(openApiPath)) !== null) {
    params.push({ name: m[1], in: 'path', required: true, schema: { type: 'string' } });
  }
  return params;
}

function queryParameters(props: string[]): Array<{ name: string; in: 'query'; schema: { type: string } }> {
  return props.map((name) => ({ name, in: 'query' as const, schema: { type: 'string' } }));
}

function yamlStringify(value: unknown, indent = 0): string {
  const pad = '  '.repeat(indent);
  if (value === null || value === undefined) {
    return `${pad}null`;
  }
  if (typeof value === 'boolean') {
    return `${pad}${value}`;
  }
  if (typeof value === 'number') {
    return `${pad}${value}`;
  }
  if (typeof value === 'string') {
    if (value === '') {
      return `${pad}""`;
    }
    const needsQuote = /[:#{}[\],&*!?|>'"@%-]/g.test(value) || value.startsWith('`');
    if (needsQuote || value.trim() !== value) {
      return `${pad}${JSON.stringify(value)}`;
    }
    return `${pad}${value}`;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return `${pad}[]`;
    }
    return value.map((item) => `${pad}- ${yamlStringify(item, 0).trimStart()}`).join('\n');
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (keys.length === 0) {
      return `${pad}{}`;
    }
    return keys
      .map((key) => {
        const safeKey = /[:#{}[\],&*!?|>'"@%-]/g.test(key) || key.startsWith('`') ? JSON.stringify(key) : key;
        const child = yamlStringify(obj[key], indent + 1);
        const firstLine = child.slice(0, child.indexOf('\n') === -1 ? undefined : child.indexOf('\n'));
        const rest = child.indexOf('\n') === -1 ? '' : child.slice(child.indexOf('\n'));
        if (obj[key] !== null && typeof obj[key] === 'object' && !Array.isArray(obj[key])) {
          return `${pad}${safeKey}:\n${child}`;
        }
        return `${pad}${safeKey}: ${firstLine.trimStart()}${rest}`;
      })
      .join('\n');
  }
  return `${pad}${String(value)}`;
}

function buildSpec(routes: RouteInfo[]): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};

  for (const route of routes) {
    if (!paths[route.openApiPath]) {
      paths[route.openApiPath] = {};
    }

    const params = [...pathParameters(route.openApiPath)];
    if (route.method === 'get') {
      params.push(...queryParameters(route.queryProps));
    }

    const operation: Record<string, unknown> = {
      summary: route.summary,
      operationId: operationId(route.method, route.openApiPath),
      tags: [route.tag],
    };

    if (params.length > 0) {
      operation.parameters = params;
    }

    if ((route.method === 'post' || route.method === 'patch' || route.method === 'put') && route.bodyProps.length > 0) {
      operation.requestBody = {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: Object.fromEntries(
                route.bodyProps.map((name) => [name, { type: 'string' }] as const),
              ),
            },
          },
        },
      };
    }

    operation.responses = {
      ...(route.method === 'post' ? { '201': { description: 'Created' } } : { '200': { description: 'OK' } }),
      '401': { description: 'Unauthorized' },
      '404': { description: 'Not Found' },
      '500': { description: 'Internal Server Error' },
    };

    paths[route.openApiPath][route.method] = operation;
  }

  return {
    openapi: '3.0.3',
    info: {
      title: 'Agent Collaboration OS API',
      version: '2.0.0',
      description: 'Auto-generated OpenAPI spec from backend/src/routes/*.ts',
    },
    servers: [
      { url: 'http://localhost:18080/agent', description: 'Local development' },
    ],
    paths,
    components: {
      securitySchemes: {
        BearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
        },
        ApiKeyAuth: {
          type: 'apiKey',
          in: 'header',
          name: 'X-API-Key',
        },
      },
    },
    security: [{ BearerAuth: [] }],
  };
}

function main() {
  if (!fs.existsSync(routesDir)) {
    console.error(`Routes directory not found: ${routesDir}`);
    process.exit(1);
  }

  const routes = collectRoutes();
  const spec = buildSpec(routes);

  // Custom YAML emitter that preserves a readable order for top-level keys.
  const lines: string[] = [];
  lines.push(`openapi: ${spec.openapi}`);
  lines.push('info:');
  lines.push(`  title: ${JSON.stringify(spec.info.title)}`);
  lines.push(`  version: ${spec.info.version}`);
  lines.push(`  description: ${JSON.stringify(spec.info.description)}`);
  lines.push('servers:');
  for (const server of spec.servers as Array<{ url: string; description: string }>) {
    lines.push(`  - url: ${server.url}`);
    lines.push(`    description: ${server.description}`);
  }
  lines.push('paths:');
  lines.push(yamlStringify(spec.paths, 1));
  lines.push('components:');
  lines.push(yamlStringify(spec.components, 1));
  lines.push('security:');
  lines.push(yamlStringify(spec.security, 1));

  const yaml = lines.join('\n') + '\n';
  fs.writeFileSync(outputPath, yaml, 'utf8');
  console.log(`Wrote ${routes.length} operations to ${outputPath}`);
}

main();
