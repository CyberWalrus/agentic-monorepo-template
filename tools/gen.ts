/**
 * Генератор заготовки фичи (c7).
 *
 *   pnpm gen feature <name>   — заготовки во всех слоях: контракт, модуль API,
 *                               фича web, каталог E2E, план в e2e/specs/<name>.md
 *   pnpm gen canary           — канарейка: временный worktree от HEAD,
 *                               генерация фичи, pnpm verify, уборка
 *
 * <name> — kebab-case (tasks, notes, todo-lists): каталоги и путь контракта
 * берутся как есть, символы кода — camelCase (todoLists), сущность — отрезанием
 * хвостовой 's' (notes → Note). Заготовка — вертикальный срез list+create с
 * политикой public, проходит pnpm verify без правок — это и проверяет
 * канарейка.
 *
 * Чего заготовка сознательно не делает: не монтирует страницу в маршрут
 * (routeTree.gen.ts пишет vite при сборке — маршрут добавляет автор фичи,
 * вместе с визуальным тестом и перф-бюджетом), не генерирует Postgres-слой
 * (образец — tasks/database.ts за тем же интерфейсом репозитория).
 *
 * Проводка в общие файлы (contracts/index.ts, api/router.ts, authorization.ts,
 * app.ts) — якорными вставками: якорь обязан встречаться ровно один раз,
 * дрейф образца ломает генератор громко, а не молча. Класс защиты: review
 * (ADR 0014) — инструмент разработчика, не гейт.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const capitalize = (part: string): string => part.charAt(0).toUpperCase() + part.slice(1);

/** Имя фичи во всех формах, которые нужны шаблонам и проводке. */
interface FeatureNames {
  /** kebab-case как ввели: каталоги, путь контракта, каталог E2E (todo-lists). */
  name: string;
  /** camelCase коллекции — символы кода: контекст, ключ контракта (todoLists). */
  camel: string;
  /** PascalCase коллекции: компоненты, заголовок экрана (TodoLists). */
  pascal: string;
  /** Сущность в kebab — имя без хвостовой 's' (todo-list). */
  entity: string;
  /** PascalCase сущности: тип, репозиторий, форма (TodoList). */
  entityPascal: string;
  /** CONSTANT_CASE сущности: константа лимита заголовка (TODO_LIST). */
  entityConst: string;
}

/**
 * Разбирает имя фичи. Бросает Error с человеческим текстом — CLI печатает его,
 * тесты проверяют throw.
 */
function parseFeatureName(raw: string): FeatureNames {
  const name = raw.trim();
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(name)) {
    throw new Error(
      `Имя фичи «${raw}» не подходит: нужно kebab-case строчными (tasks, notes, todo-lists) — из него собираются пути и имена.`,
    );
  }
  const entity = name.endsWith('s') ? name.slice(0, -1) : name;
  if (entity.length === 0) {
    throw new Error(`Имя фичи «${name}» не подходит: сущность после отрезания 's' пустая.`);
  }
  const camel = name
    .split('-')
    .map((part, index) => (index === 0 ? part : capitalize(part)))
    .join('');
  const entityPascal = entity.split('-').map(capitalize).join('');
  return {
    name,
    camel,
    pascal: name.split('-').map(capitalize).join(''),
    entity,
    entityPascal,
    entityConst: entity.replaceAll('-', '_').toUpperCase(),
  };
}

// --- Шаблоны новых файлов -------------------------------------------------------
// Содержимое держится в стиле окружающего кода и должно оставаться совместимым
// с гейтами: oxfmt (printWidth 100), oxlint (type-aware), трассировка AC
// (e2e/features/traceability). Канарейка (pnpm gen canary) ловит дрейф.

function contractTemplate(f: FeatureNames): string {
  const E = f.entityPascal;
  return `/**
 * Заготовка контракта фичи ${f.name} — сгенерировано \`pnpm gen feature ${f.name}\`.
 * Дорабатывай под фичу: поля схемы, процедуры, политика доступа (public
 * меняется на owner/admin по образцу tasks). После изменения контракта —
 * \`pnpm --filter @repo/contracts openapi\`.
 */
import * as z from 'zod';

import { ocAccess } from './access-policy.ts';

export const ${E}_TITLE_MAX_LENGTH = 200;

export const ${E}Schema = z.object({
  id: z.uuid(),
  title: z.string().min(1).max(${E}_TITLE_MAX_LENGTH),
  createdAt: z.iso.datetime(),
});

export const Create${E}InputSchema = z.object({
  title: z.string().trim().min(1, 'Title is required').max(${E}_TITLE_MAX_LENGTH),
});

export type ${E} = z.infer<typeof ${E}Schema>;
export type Create${E}Input = z.infer<typeof Create${E}InputSchema>;

export const ${f.camel}Contract = {
  list: ocAccess
    .route({ method: 'GET', path: '/${f.name}', summary: 'List ${f.name}, newest first' })
    .meta({ access: { type: 'public' } })
    .output(z.array(${E}Schema)),
  create: ocAccess
    .route({ method: 'POST', path: '/${f.name}', summary: 'Create a ${f.entity}' })
    .meta({ access: { type: 'public' } })
    .input(Create${E}InputSchema)
    .output(${E}Schema),
};
`;
}

function contractTestTemplate(f: FeatureNames): string {
  const E = f.entityPascal;
  return `import { describe, expect, it } from 'vitest';

import { Create${E}InputSchema, ${E}_TITLE_MAX_LENGTH, ${E}Schema } from './${f.name}.ts';

describe('Create${E}InputSchema', () => {
  it('trims the title', () => {
    expect(Create${E}InputSchema.parse({ title: '  Buy milk  ' })).toEqual({ title: 'Buy milk' });
  });

  it('rejects a title that is empty after trimming', () => {
    const result = Create${E}InputSchema.safeParse({ title: '   ' });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe('Title is required');
  });

  it('accepts a title of exactly the maximum length', () => {
    const title = 'a'.repeat(${E}_TITLE_MAX_LENGTH);

    expect(Create${E}InputSchema.parse({ title })).toEqual({ title });
  });

  it('rejects a title longer than the maximum length', () => {
    const title = 'a'.repeat(${E}_TITLE_MAX_LENGTH + 1);

    expect(Create${E}InputSchema.safeParse({ title }).success).toBe(false);
  });
});

describe('${E}Schema', () => {
  const valid = {
    id: '0b6f5f0e-6a43-4b8e-9d55-5a4f8f3a3c11',
    title: 'Write tests',
    createdAt: '2026-11-01T10:00:00.000Z',
  };

  it('accepts a valid ${f.entity}', () => {
    expect(${E}Schema.parse(valid)).toEqual(valid);
  });

  it('rejects a non-uuid id', () => {
    expect(${E}Schema.safeParse({ ...valid, id: '42' }).success).toBe(false);
  });

  it('rejects a non-ISO createdAt', () => {
    expect(${E}Schema.safeParse({ ...valid, createdAt: 'yesterday' }).success).toBe(false);
  });
});
`;
}

function repositoryTemplate(f: FeatureNames): string {
  const E = f.entityPascal;
  return `import { randomUUID } from 'node:crypto';

import type { ${E} } from '@repo/contracts';

export interface ${E}Repository {
  list(): Promise<${E}[]>;
  create(title: string): Promise<${E}>;
  /** Заменяет всё хранилище: сидирование тестовых данных. */
  reset(${f.name}: readonly ${E}[]): Promise<void>;
}

/**
 * Хранилище в памяти — заготовка из \`pnpm gen feature ${f.name}\`. Достаточно
 * для разработки и тестов; реализация на Postgres появится за тем же
 * интерфейсом (образец: tasks/database.ts и tasks/postgres-repository.ts).
 */
export class InMemory${E}Repository implements ${E}Repository {
  readonly #${f.name} = new Map<string, ${E}>();
  readonly #now: () => Date;
  readonly #generateId: () => string;

  constructor({
    now = () => new Date(),
    generateId = randomUUID,
  }: {
    now?: () => Date;
    generateId?: () => string;
  } = {}) {
    this.#now = now;
    this.#generateId = generateId;
  }

  async list(): Promise<${E}[]> {
    const ${f.name} = [...this.#${f.name}.values()];
    return ${f.name}.toSorted((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async create(title: string): Promise<${E}> {
    const ${f.entity}: ${E} = {
      id: this.#generateId(),
      title,
      createdAt: this.#now().toISOString(),
    };
    this.#${f.name}.set(${f.entity}.id, ${f.entity});
    return ${f.entity};
  }

  async reset(${f.name}: readonly ${E}[]): Promise<void> {
    this.#${f.name}.clear();
    for (const ${f.entity} of ${f.name}) {
      this.#${f.name}.set(${f.entity}.id, ${f.entity});
    }
  }
}
`;
}

function repositoryTestTemplate(f: FeatureNames): string {
  const E = f.entityPascal;
  return `import { describe, expect, it } from 'vitest';

import { InMemory${E}Repository } from './repository.ts';

function createRepository() {
  let tick = 0;
  let id = 0;
  return new InMemory${E}Repository({
    now: () => new Date(Date.UTC(2026, 10, 1, 10, 0, tick++)),
    generateId: () => \`00000000-0000-4000-8000-\${String(++id).padStart(12, '0')}\`,
  });
}

describe('InMemory${E}Repository', () => {
  it('creates a ${f.entity} with the injected id generator and clock', async () => {
    const repository = createRepository();

    const ${f.entity} = await repository.create('Write tests');

    expect(${f.entity}).toEqual({
      id: '00000000-0000-4000-8000-000000000001',
      title: 'Write tests',
      createdAt: '2026-11-01T10:00:00.000Z',
    });
  });

  it('orders ${f.name} created later first using the captured clock', async () => {
    const repository = createRepository();
    await repository.create('first');
    await repository.create('second');
    await repository.create('third');

    const titles = (await repository.list()).map((${f.entity}) => ${f.entity}.title);

    expect(titles).toEqual(['third', 'second', 'first']);
  });
});
`;
}

function apiTestTemplate(f: FeatureNames): string {
  const E = f.entityPascal;
  return `import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { ContractRouterClient } from '@orpc/contract';
import { type Contract } from '@repo/contracts';
import { describe, expect, it } from 'vitest';

import { createApp } from '../app.ts';
import { InMemoryTaskRepository } from '../tasks/repository.ts';
import { InMemory${E}Repository } from './repository.ts';

/**
 * Проводка заготовки ${f.name} (сгенерировано \`pnpm gen feature ${f.name}\`):
 * контракт → контекст → RPC-транспорт. Транспорт в модуле приложения не
 * подменяется — клиент строится поверх app.fetch, как в app.test.ts.
 */
function setup() {
  const app = createApp({
    tasks: new InMemoryTaskRepository(),
    ${f.camel}: new InMemory${E}Repository(),
  });
  const client: ContractRouterClient<Contract> = createORPCClient(
    new RPCLink({ url: 'http://api.test/rpc', fetch: async (request) => app.fetch(request) }),
  );
  return { app, client };
}

describe('${f.camel} API wiring', () => {
  it('creates and lists ${f.name} through the typed client', async () => {
    const { client } = setup();

    const created = await client.${f.camel}.create({ title: '  Ship it  ' });
    const list = await client.${f.camel}.list();

    expect(created.title).toBe('Ship it');
    expect(list).toEqual([created]);
  });

  it('rejects an empty title with a validation error', async () => {
    const { client } = setup();

    await expect(client.${f.camel}.create({ title: '   ' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });
});
`;
}

function pageTemplate(f: FeatureNames): string {
  const E = f.entityPascal;
  return `import type { ${E} } from '@repo/contracts';
import { useState } from 'react';

import { useHydrated } from '../../lib/use-hydrated.ts';
import { Create${E}Form } from './Create${E}Form.tsx';

/**
 * Экран фичи ${f.name} — заготовка из \`pnpm gen feature ${f.name}\`. Состояния:
 * пусто, список, ошибка создания. Маршрут добавляет автор фичи (routeTree.gen.ts
 * пишет vite при сборке; образец проводки с Suspense — routes/index.tsx), там
 * же появляется состояние загрузки.
 */
export interface ${f.pascal}PageProps {
  ${f.name}: readonly ${E}[];
  onCreate: (title: string) => Promise<void>;
}

export function ${f.pascal}Page({ ${f.name}: ${f.entity}s, onCreate }: ${f.pascal}PageProps) {
  const [error, setError] = useState<string | null>(null);
  // До гидратации клик по SSR-разметке теряется: React вернёт серверное состояние.
  const interactive = useHydrated();

  function handleCreate(title: string) {
    setError(null);
    onCreate(title).catch(() => setError('Could not create the ${f.entity}. Try again.'));
  }

  return (
    <main>
      <h1>${f.pascal}</h1>
      <Create${E}Form onCreate={handleCreate} disabled={!interactive} />
      {error ? <p role="alert">{error}</p> : null}
      {${f.entity}s.length === 0 ? (
        <p>Nothing here yet. Add your first ${f.entity} above.</p>
      ) : (
        <ul aria-label="${f.pascal}">
          {${f.entity}s.map((${f.entity}) => (
            <li key={${f.entity}.id}>{${f.entity}.title}</li>
          ))}
        </ul>
      )}
    </main>
  );
}
`;
}

function pageTestTemplate(f: FeatureNames): string {
  const E = f.entityPascal;
  return `import type { ${E} } from '@repo/contracts';
import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import { ${f.pascal}Page } from './${f.pascal}Page.tsx';

const ${f.name}: ${E}[] = [
  {
    id: '00000000-0000-4000-8000-000000000001',
    title: 'Buy milk',
    createdAt: '2026-11-01T10:00:00.000Z',
  },
];

describe('${f.pascal}Page', () => {
  it('shows the empty state when there are no ${f.name}', async () => {
    const screen = await render(<${f.pascal}Page ${f.name}={[]} onCreate={async () => {}} />);

    await expect.element(screen.getByText(/Nothing here yet/)).toBeVisible();
    await expect.element(screen.getByRole('heading', { name: '${f.pascal}' })).toBeVisible();
  });

  it('renders ${f.name} as a labelled list', async () => {
    const screen = await render(<${f.pascal}Page ${f.name}={${f.name}} onCreate={async () => {}} />);

    await expect.element(screen.getByRole('list', { name: '${f.pascal}' })).toBeVisible();
    await expect.element(screen.getByText('Buy milk')).toBeVisible();
  });

  it('passes the typed title to onCreate', async () => {
    const onCreate = vi.fn<(title: string) => Promise<void>>(async () => {});
    const screen = await render(<${f.pascal}Page ${f.name}={${f.name}} onCreate={onCreate} />);

    await screen.getByLabel('New ${f.entity}').fill('  Ship it  ');
    await screen.getByRole('button', { name: 'Add ${f.entity}' }).click();

    expect(onCreate).toHaveBeenCalledExactlyOnceWith('Ship it');
  });

  it('reports an error when the creation fails', async () => {
    const onCreate = vi.fn<(title: string) => Promise<void>>(async () => {
      throw new Error('boom');
    });
    const screen = await render(<${f.pascal}Page ${f.name}={${f.name}} onCreate={onCreate} />);

    await screen.getByLabel('New ${f.entity}').fill('Buy milk');
    await screen.getByRole('button', { name: 'Add ${f.entity}' }).click();

    await expect
      .element(screen.getByRole('alert'))
      .toHaveTextContent('Could not create the ${f.entity}. Try again.');
  });
});
`;
}

function formTemplate(f: FeatureNames): string {
  const E = f.entityPascal;
  return `import { Create${E}InputSchema } from '@repo/contracts';
import { Button, TextField } from '@repo/ui';
import { useState, type FormEvent } from 'react';

/**
 * Форма создания — заготовка из \`pnpm gen feature ${f.name}\`. Та же схема, что
 * валидирует вход на сервере: правила не расходятся (образец: CreateTaskForm).
 */
export interface Create${E}FormProps {
  onCreate: (title: string) => Promise<void>;
  disabled?: boolean;
}

export function Create${E}Form({ onCreate, disabled = false }: Create${E}FormProps) {
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = Create${E}InputSchema.safeParse({ title });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Invalid title');
      return;
    }

    setError(undefined);
    setSubmitting(true);
    try {
      await onCreate(parsed.data.title);
      setTitle('');
    } catch {
      setError('Could not create the ${f.entity}. Try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={(event) => void handleSubmit(event)} noValidate>
      <TextField
        label="New ${f.entity}"
        name="title"
        placeholder="Write it down"
        autoComplete="off"
        value={title}
        error={error}
        disabled={disabled}
        onChange={(event) => setTitle(event.target.value)}
      />
      <Button type="submit" disabled={disabled || submitting}>
        Add ${f.entity}
      </Button>
    </form>
  );
}
`;
}

function formTestTemplate(f: FeatureNames): string {
  const E = f.entityPascal;
  return `import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import { Create${E}Form } from './Create${E}Form.tsx';

describe('Create${E}Form', () => {
  it('submits the trimmed title and clears the field', async () => {
    const onCreate = vi.fn<(title: string) => Promise<void>>(async () => {});
    const screen = await render(<Create${E}Form onCreate={onCreate} />);

    await screen.getByLabel('New ${f.entity}').fill('  Buy milk  ');
    await screen.getByRole('button', { name: 'Add ${f.entity}' }).click();

    expect(onCreate).toHaveBeenCalledExactlyOnceWith('Buy milk');
    await expect.element(screen.getByLabel('New ${f.entity}')).toHaveValue('');
  });

  it('shows the shared validation message and does not submit an empty title', async () => {
    const onCreate = vi.fn<(title: string) => Promise<void>>(async () => {});
    const screen = await render(<Create${E}Form onCreate={onCreate} />);

    await screen.getByRole('button', { name: 'Add ${f.entity}' }).click();

    await expect.element(screen.getByRole('alert')).toHaveTextContent('Title is required');
    expect(onCreate).not.toHaveBeenCalled();
  });

  it('keeps the input and shows an error when creation fails', async () => {
    const onCreate = vi.fn<(title: string) => Promise<void>>(async () => {
      throw new Error('network down');
    });
    const screen = await render(<Create${E}Form onCreate={onCreate} />);

    await screen.getByLabel('New ${f.entity}').fill('Retry me');
    await screen.getByRole('button', { name: 'Add ${f.entity}' }).click();

    await expect
      .element(screen.getByRole('alert'))
      .toHaveTextContent('Could not create the ${f.entity}. Try again.');
    await expect.element(screen.getByLabel('New ${f.entity}')).toHaveValue('Retry me');
  });
});

describe('Create${E}Form when disabled', () => {
  it('blocks typing and submitting', async () => {
    const screen = await render(<Create${E}Form onCreate={async () => {}} disabled />);

    await expect.element(screen.getByLabel('New ${f.entity}')).toBeDisabled();
    await expect.element(screen.getByRole('button', { name: 'Add ${f.entity}' })).toBeDisabled();
  });
});
`;
}

function hooksTemplate(f: FeatureNames): string {
  const E = f.entityPascal;
  return `import type { ${E} } from '@repo/contracts';
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
  type QueryClient,
} from '@tanstack/react-query';

import { orpc } from '../../lib/api-client.ts';

const listKey = orpc.${f.camel}.list.queryKey();

export const ${f.camel}ListQuery = orpc.${f.camel}.list.queryOptions();

export function use${f.pascal}() {
  return useSuspenseQuery(${f.camel}ListQuery).data;
}

/**
 * Перезапрашиваем список только после последней мутации ${f.name}. Иначе
 * refetch, стартовавший между двумя мутациями, затрёт промежуточным состоянием
 * данные второй (образец: features/tasks/use-tasks.ts — там же паттерн
 * оптимистичного обновления, когда оно понадобится).
 */
async function refetchAfterLastMutation(queryClient: QueryClient) {
  if (queryClient.isMutating({ mutationKey: orpc.${f.camel}.key() }) === 1) {
    await queryClient.invalidateQueries({ queryKey: listKey });
  }
}

export function useCreate${E}() {
  const queryClient = useQueryClient();
  const mutation = useMutation(
    orpc.${f.camel}.create.mutationOptions({
      onSettled: () => refetchAfterLastMutation(queryClient),
    }),
  );
  return async (title: string) => {
    await mutation.mutateAsync({ title });
  };
}
`;
}

function hooksTestTemplate(f: FeatureNames): string {
  const E = f.entityPascal;
  return `import type { ${E} } from '@repo/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Suspense } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import { orpc } from '../../lib/api-client.ts';
import { ${f.pascal}Page } from './${f.pascal}Page.tsx';
import { useCreate${E}, use${f.pascal} } from './use-${f.name}.ts';

/**
 * Хуки заготовки ${f.name}: данные через настоящий @orpc/tanstack-query,
 * транспорт подменяется (паттерн из use-tasks.test.tsx).
 */
const transport = vi.hoisted(() => {
  const stubbed = {
    list: () => {
      throw new Error('transport is not configured for this test');
    },
    create: (_input: { title: string }) => {
      throw new Error('transport is not configured for this test');
    },
  };
  return stubbed;
});

vi.mock('../../lib/api-client.ts', async () => {
  const { createTanstackQueryUtils } = await import('@orpc/tanstack-query');

  return {
    orpc: createTanstackQueryUtils({
      ${f.camel}: {
        list: () => transport.list(),
        create: (input: { title: string }) => transport.create(input),
      },
    }),
  };
});

const seeded: ${E} = {
  id: '00000000-0000-4000-8000-000000000001',
  title: 'Buy milk',
  createdAt: '2026-11-01T10:00:00.000Z',
};

function ${f.pascal}Screen() {
  const ${f.name} = use${f.pascal}();
  const onCreate = useCreate${E}();

  return <${f.pascal}Page ${f.name}={${f.name}} onCreate={onCreate} />;
}

function renderScreen(client: QueryClient) {
  return render(
    <QueryClientProvider client={client}>
      <Suspense fallback={<p>Loading ${f.name}…</p>}>
        <${f.pascal}Screen />
      </Suspense>
    </QueryClientProvider>,
  );
}

describe('use-${f.name}', () => {
  it('renders the list from the transport through the hook', async () => {
    transport.list = async () => [seeded];
    const screen = renderScreen(new QueryClient());

    await expect.element(screen.getByText('Buy milk')).toBeVisible();
  });

  it('refetches the list after the create mutation settles', async () => {
    let created = false;
    transport.list = async () => (created ? [{ ...seeded, title: 'Ship it' }] : []);
    transport.create = async (input) => {
      created = true;
      return { ...seeded, title: input.title };
    };
    const screen = renderScreen(new QueryClient());

    await expect.element(screen.getByText(/Nothing here yet/)).toBeVisible();
    await screen.getByLabel('New ${f.entity}').fill('Ship it');
    await screen.getByRole('button', { name: 'Add ${f.entity}' }).click();

    // Новая запись приходит с сервера через инвалидацию после мутации.
    await expect.element(screen.getByText('Ship it')).toBeVisible();
  });
});
`;
}

function e2eSpecTemplate(f: FeatureNames): string {
  return `import { API_URL, expect, test } from '../../fixtures.ts';

// Контрактный E2E заготовки ${f.name} (сгенерировано \`pnpm gen feature ${f.name}\`):
// части системы соединены — контракт → API → OpenAPI-транспорт. UI-сценарии
// добавляются, когда страница фичи получит маршрут; тогда же дополняется план
// e2e/specs/${f.name}.md. Сценарии параллельны: данные через uniqueTitle().
test.describe('${f.name} contract', () => {
  test('created ${f.entity} appears in the list [AC-1]', async ({ request, uniqueTitle }) => {
    const title = uniqueTitle('Generated ${f.entity}');

    const create = await request.post(\`\${API_URL}/api/${f.name}\`, { data: { title } });
    expect(create.status(), 'create through the OpenAPI transport').toBe(200);

    const list = await request.get(\`\${API_URL}/api/${f.name}\`);
    expect(list.status(), 'list through the OpenAPI transport').toBe(200);
    const ${f.name} = (await list.json()) as Array<{ title: string }>;
    expect(${f.name}.map((${f.entity}) => ${f.entity}.title)).toContain(title);
  });

  test('title empty after trim is rejected [AC-2]', async ({ request }) => {
    const create = await request.post(\`\${API_URL}/api/${f.name}\`, { data: { title: '   ' } });

    expect(create.status(), 'contract validation runs end-to-end').toBe(400);
  });
});
`;
}

function specPlanTemplate(f: FeatureNames): string {
  const E = f.entityPascal;
  return `# ${f.pascal}

E2E-план фичи ${f.name} — заготовка, сгенерированная \`pnpm gen feature ${f.name}\`.
Критерии приёмки; у каждого есть хотя бы один тест в \`e2e/features/${f.name}/\` —
это проверяет гейт трассировки
(\`e2e/features/traceability/traceability.spec.ts\`). Сценарии идут параллельно:
данные через \`uniqueTitle()\`, порядок не assumes. Дорабатывая фичу, дополняй
критерии и тесты вместе; UI-сценарии приходят с маршрутом страницы.

## Критерии приёмки

- **AC-1**: Созданный через API ${f.entity} появляется в списке (контракт → API → OpenAPI-транспорт соединены).
- **AC-2**: Запрос на создание с заголовком, пустым после trim, отклоняется валидацией контракта (${E}Schema → BAD_REQUEST).
`;
}

// --- Проводка в общие файлы (якорные вставки) -----------------------------------

interface Patch {
  /** Путь относительно корня репозитория. */
  file: string;
  /** Точная подстрока-якорь: должна встречаться в файле ровно один раз. */
  anchor: string;
  /** Полный текст замены: якорь вместе с дописанным блоком. */
  replacement: string;
}

function patchesFor(f: FeatureNames): Patch[] {
  const E = f.entityPascal;
  return [
    {
      file: 'packages/contracts/src/index.ts',
      anchor: `import { tasksContract } from './tasks.ts';`,
      replacement: `import { ${f.camel}Contract } from './${f.name}.ts';\nimport { tasksContract } from './tasks.ts';`,
    },
    {
      file: 'packages/contracts/src/index.ts',
      anchor: `  tasks: tasksContract,`,
      replacement: `  tasks: tasksContract,\n  ${f.camel}: ${f.camel}Contract,`,
    },
    {
      // Якорь с «type Task,»: одна строка `} from './tasks.ts';` встречается и
      // в конце import-строки выше.
      file: 'packages/contracts/src/index.ts',
      anchor: `  type Task,\n} from './tasks.ts';`,
      replacement: `  type Task,\n} from './tasks.ts';\n\nexport {\n  Create${E}InputSchema,\n  ${E}_TITLE_MAX_LENGTH,\n  ${E}Schema,\n  type Create${E}Input,\n  type ${E},\n} from './${f.name}.ts';`,
    },
    {
      file: 'apps/api/src/router.ts',
      anchor: `  },\n});`,
      replacement: `  },\n  ${f.camel}: {\n    list: os.${f.camel}.list.handler(({ context }) => context.${f.camel}.list()),\n    create: os.${f.camel}.create.handler(({ input, context }) =>\n      context.${f.camel}.create(input.title),\n    ),\n  },\n});`,
    },
    {
      file: 'apps/api/src/authorization.ts',
      anchor: `import type { TaskRepository } from './tasks/repository.ts';`,
      replacement: `import type { ${E}Repository } from './${f.name}/repository.ts';\nimport type { TaskRepository } from './tasks/repository.ts';`,
    },
    {
      file: 'apps/api/src/authorization.ts',
      anchor: `  tasks: TaskRepository;`,
      replacement: `  tasks: TaskRepository;\n  ${f.camel}: ${E}Repository;`,
    },
    {
      file: 'apps/api/src/app.ts',
      anchor: `import type { TaskRepository } from './tasks/repository.ts';`,
      replacement: `import type { ${E}Repository } from './${f.name}/repository.ts';\nimport type { TaskRepository } from './tasks/repository.ts';`,
    },
    {
      file: 'apps/api/src/app.ts',
      anchor: `  tasks: TaskRepository;`,
      replacement: `  tasks: TaskRepository;\n  ${f.camel}: ${E}Repository;`,
    },
    {
      file: 'apps/api/src/app.ts',
      anchor: `  tasks,\n  router = defaultRouter,`,
      replacement: `  ${f.camel},\n  tasks,\n  router = defaultRouter,`,
    },
    {
      file: 'apps/api/src/app.ts',
      anchor: `const buildContext = (request: Request): AppContext => ({`,
      replacement: `const buildContext = (request: Request): AppContext => ({\n    ${f.camel},`,
    },
  ];
}

// --- План и применение ------------------------------------------------------------

interface PlannedFile {
  path: string;
  content: string;
}

interface FeaturePlan {
  names: FeatureNames;
  files: PlannedFile[];
  patches: Patch[];
}

function plannedFiles(f: FeatureNames): PlannedFile[] {
  const E = f.entityPascal;
  return [
    { path: `packages/contracts/src/${f.name}.ts`, content: contractTemplate(f) },
    { path: `packages/contracts/src/${f.name}.test.ts`, content: contractTestTemplate(f) },
    { path: `apps/api/src/${f.name}/repository.ts`, content: repositoryTemplate(f) },
    { path: `apps/api/src/${f.name}/repository.test.ts`, content: repositoryTestTemplate(f) },
    { path: `apps/api/src/${f.name}/api.test.ts`, content: apiTestTemplate(f) },
    { path: `apps/web/src/features/${f.name}/${f.pascal}Page.tsx`, content: pageTemplate(f) },
    {
      path: `apps/web/src/features/${f.name}/${f.pascal}Page.test.tsx`,
      content: pageTestTemplate(f),
    },
    {
      path: `apps/web/src/features/${f.name}/Create${E}Form.tsx`,
      content: formTemplate(f),
    },
    {
      path: `apps/web/src/features/${f.name}/Create${E}Form.test.tsx`,
      content: formTestTemplate(f),
    },
    { path: `apps/web/src/features/${f.name}/use-${f.name}.ts`, content: hooksTemplate(f) },
    {
      path: `apps/web/src/features/${f.name}/use-${f.name}.test.tsx`,
      content: hooksTestTemplate(f),
    },
    { path: `e2e/features/${f.name}/${f.name}.spec.ts`, content: e2eSpecTemplate(f) },
    { path: `e2e/specs/${f.name}.md`, content: specPlanTemplate(f) },
  ];
}

/**
 * План генерации без записи на диск: коллизии файлов и дрейф якорей ловятся
 * здесь, до первого writeFileSync (генерация либо применяется целиком, либо
 * не применяется вовсе).
 */
function planFeature(root: string, rawName: string): FeaturePlan {
  const names = parseFeatureName(rawName);
  const files = plannedFiles(names);
  const collisions = files.filter((file) => existsSync(join(root, file.path))).map((f) => f.path);
  if (collisions.length > 0) {
    throw new Error(
      `Фича «${names.name}» уже существует или конфликтует по файлам:\n  ${collisions.join('\n  ')}\nГенератор не перезаписывает: выбери другое имя или дорабатывай фичу руками.`,
    );
  }
  const patches = patchesFor(names);
  for (const patch of patches) {
    const content = readFileSync(join(root, patch.file), 'utf8');
    const occurrences = content.split(patch.anchor).length - 1;
    if (occurrences !== 1) {
      throw new Error(
        `Якорь проводки в ${patch.file} встречается ${occurrences} раз(а), а должен ровно один:\n  ${JSON.stringify(patch.anchor)}\nДрейф файла-образца: обнови patchesFor() в tools/gen.ts под новый вид файла.`,
      );
    }
  }
  return { names, files, patches };
}

/** Замена якоря с повторной проверкой единственности (безопасна сама по себе). */
function applyPatch(content: string, patch: Patch): string {
  const occurrences = content.split(patch.anchor).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `Якорь в ${patch.file} встречается ${occurrences} раз(а), а должен ровно один.`,
    );
  }
  return content.replace(patch.anchor, patch.replacement);
}

function applyFeature(root: string, plan: FeaturePlan): void {
  for (const file of plan.files) {
    mkdirSync(dirname(join(root, file.path)), { recursive: true });
    writeFileSync(join(root, file.path), file.content);
  }
  for (const patch of plan.patches) {
    const target = join(root, patch.file);
    writeFileSync(target, applyPatch(readFileSync(target, 'utf8'), patch));
  }
}

/** Перегенерирует openapi.json под обновлённый контракт. */
function runOpenapiGen(root: string): void {
  const result = spawnSync('pnpm', ['--filter', '@repo/contracts', 'openapi'], {
    cwd: root,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    throw new Error('pnpm --filter @repo/contracts openapi завершился с ошибкой.');
  }
}

/** Форматирует созданные и пропатченные файлы: гейт format остаётся зелёным. */
function runFormatter(root: string, files: readonly string[]): void {
  const result = spawnSync('pnpm', ['exec', 'oxfmt', ...files], { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Error('oxfmt завершился с ошибкой на сгенерированных файлах.');
  }
}

function printSummary(plan: FeaturePlan): void {
  const created = plan.files.map((file) => `  + ${file.path}`);
  const patched = [...new Set(plan.patches.map((patch) => patch.file))].map(
    (file) => `  ~ ${file}`,
  );
  console.log(
    `Фича «${plan.names.name}» сгенерирована.\n\nНовые файлы:\n${created.join('\n')}\n\nПроводка:\n${patched.join(
      '\n',
    )}\n  ~ packages/contracts/openapi.json (перегенерирован)\n\nФайлы отформатированы oxfmt. Дальше (за автором фичи):\n  — маршрут страницы (routeTree.gen.ts пишет vite при сборке; образец — routes/index.tsx),\n    вместе с ним визуальный тест и бюджет в perf-budgets.json (его правит человек);\n  — реальные поля схемы и процедуры контракта, затем \`pnpm --filter @repo/contracts openapi\`;\n  — план e2e/specs/${plan.names.name}.md дополняется вместе с тестами.`,
  );
}

// --- Канарейка --------------------------------------------------------------------
// Канарейка проверяет обещание генератора: сгенерированная фича во временном
// worktree проходит pnpm verify без правок. Worktree — от HEAD текущей ветки:
// сначала закоммить генератор, потом гони канарейку.

const CANARY_FEATURE = 'gen-canary';

function canaryWorktreePath(root: string): string {
  return join(dirname(root), `${basename(root)}-gen-canary`);
}

function repoRoot(): string {
  const result = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  const root = result.status === 0 ? result.stdout.trim() : '';
  if (root === '') {
    throw new Error('Запускай генератор внутри репозитория: git rev-parse --show-toplevel пуст.');
  }
  return root;
}

function runStep(command: string, args: readonly string[], cwd: string): boolean {
  const result = spawnSync(command, [...args], { cwd, stdio: 'inherit' });
  return result.status === 0;
}

function removeWorktree(root: string, worktree: string): boolean {
  const removed = spawnSync('git', ['worktree', 'remove', '--force', worktree], {
    cwd: root,
    stdio: 'ignore',
  });
  return removed.status === 0;
}

function commandCanary(root: string): void {
  const worktree = canaryWorktreePath(root);
  if (existsSync(worktree)) {
    throw new Error(
      `Каталог канарейки уже существует: ${worktree}.\nУдали его (git worktree remove --force ${worktree}) и повтори.`,
    );
  }
  const added = spawnSync('git', ['worktree', 'add', '--detach', worktree, 'HEAD'], {
    cwd: root,
    stdio: 'inherit',
  });
  if (added.status !== 0) {
    throw new Error('git worktree add завершился с ошибкой — канарейка не запущена.');
  }

  const steps: readonly { command: string; args: readonly string[] }[] = [
    { command: 'pnpm', args: ['install'] },
    { command: 'node', args: ['tools/gen.ts', 'feature', CANARY_FEATURE] },
    { command: 'pnpm', args: ['verify'] },
  ];
  let green = true;
  try {
    for (const step of steps) {
      console.log(`\n[canary] ${step.command} ${step.args.join(' ')}`);
      if (!runStep(step.command, step.args, worktree)) {
        green = false;
        break;
      }
    }
  } finally {
    if (!removeWorktree(root, worktree)) {
      console.error(
        `Не удалось удалить worktree канарейки: ${worktree}.\nУдали руками: git worktree remove --force ${worktree}`,
      );
    }
  }

  if (!green) {
    throw new Error(
      `Канарейка красная: фича ${CANARY_FEATURE} во временном worktree не прошла pnpm verify.\nШаблоны в tools/gen.ts разошлись с гейтами или с файлами-образцами — чини шаблоны, не гейты.`,
    );
  }
  console.log(
    `\nКанарейка зелёная: фича ${CANARY_FEATURE} во временном worktree прошла pnpm verify без правок.`,
  );
}

// --- Вход -------------------------------------------------------------------------

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const [command, argument] = process.argv.slice(2);
  if (command === 'feature' && argument !== undefined) {
    try {
      const root = repoRoot();
      const plan = planFeature(root, argument);
      applyFeature(root, plan);
      runFormatter(root, [
        ...plan.files.map((file) => file.path),
        ...new Set(plan.patches.map((patch) => patch.file)),
      ]);
      runOpenapiGen(root);
      printSummary(plan);
    } catch (error: unknown) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  } else if (command === 'canary') {
    try {
      commandCanary(repoRoot());
    } catch (error: unknown) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  } else {
    console.error(
      'Команды генератора (c7):\n  pnpm gen feature <name>   — заготовка фичи во всех слоях;\n                            имя — kebab-case (tasks, notes, todo-lists)\n  pnpm gen canary           — канарейка: сгенерированная фича во временном\n                            worktree проходит pnpm verify без правок',
    );
    process.exit(1);
  }
}
