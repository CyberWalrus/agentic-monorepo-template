/**
 * Генерирует OpenAPI-спецификацию из oRPC-контракта.
 *   node scripts/openapi.ts          — перезаписать openapi.json
 *   node scripts/openapi.ts --check  — упасть, если закоммиченная спека устарела (используется в CI)
 */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { OpenAPIGenerator } from '@orpc/openapi';
import { ZodToJsonSchemaConverter } from '@orpc/zod/zod4';

import { contract } from '../src/index.ts';

const specPath = fileURLToPath(new URL('../openapi.json', import.meta.url));

const generator = new OpenAPIGenerator({ schemaConverters: [new ZodToJsonSchemaConverter()] });
const spec = await generator.generate(contract, {
  info: { title: 'Agentic Template API', version: '0.0.0' },
  servers: [{ url: '/api' }],
});
const content = `${JSON.stringify(spec, null, 2)}\n`;

if (process.argv.includes('--check')) {
  const current = await readFile(specPath, 'utf8').catch(() => '');
  if (current !== content) {
    console.error(
      'openapi.json is out of date with the contract. Run `pnpm --filter @repo/contracts openapi` and commit the result.',
    );
    process.exit(1);
  }
  console.log('openapi.json is up to date');
} else {
  await writeFile(specPath, content);
  console.log(`Wrote ${specPath}`);
}
