import { defineConfig } from 'vitest/config';

import baseConfig from './vitest.config.ts';

/**
 * Node-проект для StrykerJS (B2.2): vitest-runner не поддерживает browser mode,
 * поэтому мутационный прогон идёт только по node-проекту. Файл загружается
 * стрикером через `vitest.configFile` и обычными тестами не подхватывается —
 * `vitest.config.ts` продолжает описывать все проекты `turbo test`.
 */
const projects = baseConfig.test?.projects ?? [];
const nodeProjects = projects.filter(
  (project) => typeof project === 'object' && project.test?.name === 'node',
);
if (nodeProjects.length === 0) {
  throw new Error(
    'vitest.projects.ts: node-проект не найден в vitest.config.ts — синхронизируй конфиг StrykerJS',
  );
}

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    projects: nodeProjects,
  },
});
