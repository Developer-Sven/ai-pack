---
name: tanstack-patterns
description: Fullstack architecture with TanStack Query v5, TanStack Table v8, TanStack Router, and TanStack Start. Eliminates hallucinations around Query v4 syntax, Table headless rendering, and type-safe file routing. Use when building or reviewing TanStack apps.
---

# TanStack Ecosystem Patterns (Query v5, Table v8, Router & Start)

The TanStack suite provides a framework-agnostic, fullstack foundation for modern React and web applications.

---

## 1. TanStack Query v5 Rules

### A. Object Syntax Only
Positional arguments were removed in v5. Always pass an options object.
```ts
// ❌ WRONG (v4 syntax)
useQuery(['todos', id], () => fetchTodo(id));

// ✅ CORRECT (v5 syntax)
useQuery({
  queryKey: ['todos', id],
  queryFn: () => fetchTodo(id),
});
```

### B. `isPending` vs `isLoading`
- `isPending`: No cached data yet, query is executing for the first time. **Use `isPending` for spinners**.
- `isLoading`: `isPending && isFetching` (strictly initial load without cache).
- `gcTime` replaced `cacheTime` (Garbage Collection Time).

### C. Colocated `queryOptions`
Colocate queries via `queryOptions` to share them across loaders, components, and server functions:
```ts
// features/todos/queries.ts
import { queryOptions } from '@tanstack/react-query';

export const todoQueries = {
  all: () => ['todos'] as const,
  lists: () => [...todoQueries.all(), 'list'] as const,
  list: (filter: string) =>
    queryOptions({
      queryKey: [...todoQueries.lists(), { filter }],
      queryFn: async ({ signal }) => {
        const res = await fetch(`/api/todos?filter=${filter}`, { signal });
        if (!res.ok) throw new Error('Failed to fetch todos');
        return (await res.json()) as Todo[];
      },
      staleTime: 1000 * 60 * 5,
    }),
  detail: (id: string) =>
    queryOptions({
      queryKey: [...todoQueries.all(), 'detail', id],
      queryFn: async ({ signal }) => {
        const res = await fetch(`/api/todos/${id}`, { signal });
        if (!res.ok) throw new Error('Todo not found');
        return (await res.json()) as Todo;
      },
    }),
};
```

### D. Optimistic Mutations with Rollback
```ts
import { useMutation, useQueryClient } from '@tanstack/react-query';

export function useAddTodoMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (newTodo: { title: string }) => {
      const res = await fetch('/api/todos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newTodo),
      });
      if (!res.ok) throw new Error('Failed to create todo');
      return (await res.json()) as Todo;
    },
    onMutate: async (newTodo) => {
      await queryClient.cancelQueries({ queryKey: todoQueries.lists() });
      const previousTodos = queryClient.getQueryData(todoQueries.list('all').queryKey);

      queryClient.setQueryData(todoQueries.list('all').queryKey, (old: Todo[] = []) => [
        ...old,
        { id: `temp-${Date.now()}`, title: newTodo.title, completed: false },
      ]);

      return { previousTodos };
    },
    onError: (_err, _newTodo, context) => {
      if (context?.previousTodos) {
        queryClient.setQueryData(todoQueries.list('all').queryKey, context.previousTodos);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: todoQueries.lists() });
    },
  });
}
```

---

## 2. TanStack Table v8

### Critical Rules:
1. **Memoize Columns and Data**: Never declare `columns` or `data` directly inside component bodies without `useMemo` or static declaration.
2. **`flexRender` is Mandatory**: Always call `flexRender(cell.column.columnDef.cell, cell.getContext())`.

```tsx
import React, { useMemo, useState } from 'react';
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  SortingState,
  useReactTable,
} from '@tanstack/react-table';

interface User {
  id: string;
  name: string;
  role: 'admin' | 'user';
}

const columnHelper = createColumnHelper<User>();

export function UsersTable({ data }: { data: User[] }) {
  const [sorting, setSorting] = useState<SortingState>([]);

  const columns = useMemo(
    () => [
      columnHelper.accessor('name', {
        header: 'Name',
        cell: (info) => <strong>{info.getValue()}</strong>,
      }),
      columnHelper.accessor('role', {
        header: 'Role',
        cell: (info) => <span className={`badge-${info.getValue()}`}>{info.getValue()}</span>,
      }),
    ],
    []
  );

  const table = useReactTable({
    data,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
  });

  return (
    <table>
      <thead>
        {table.getHeaderGroups().map((headerGroup) => (
          <tr key={headerGroup.id}>
            {headerGroup.headers.map((header) => (
              <th key={header.id} onClick={header.column.getToggleSortingHandler()}>
                {flexRender(header.column.columnDef.header, header.getContext())}
                {{ asc: ' 🔼', desc: ' 🔽' }[header.column.getIsSorted() as string] ?? null}
              </th>
            ))}
          </tr>
        ))}
      </thead>
      <tbody>
        {table.getRowModel().rows.map((row) => (
          <tr key={row.id}>
            {row.getVisibleCells().map((cell) => (
              <td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
```

---

## 3. TanStack Router & TanStack Start

### Type-Safe Routing & Server Functions
```tsx
// src/routes/posts.$postId.tsx
import { createFileRoute } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import { useQuery, queryOptions } from '@tanstack/react-query';

const postSearchSchema = z.object({
  view: z.enum(['summary', 'full']).default('summary'),
});

export const getPostServerFn = createServerFn({ method: 'GET' })
  .validator((d: { postId: string }) => d)
  .handler(async ({ data }) => {
    return await db.post.findUnique({ where: { id: data.postId } });
  });

export const postDetailQueryOptions = (postId: string) =>
  queryOptions({
    queryKey: ['post', postId],
    queryFn: () => getPostServerFn({ data: { postId } }),
  });

export const Route = createFileRoute('/posts/$postId')({
  validateSearch: postSearchSchema,
  loader: async ({ params, context }) => {
    await context.queryClient.ensureQueryData(postDetailQueryOptions(params.postId));
  },
  component: PostDetailComponent,
});

function PostDetailComponent() {
  const { postId } = Route.useParams();
  const { view } = Route.useSearch();
  const { data: post } = useQuery(postDetailQueryOptions(postId));

  return (
    <article>
      <h1>{post?.title}</h1>
      <p>View: {view}</p>
      <div>{post?.content}</div>
    </article>
  );
}
```
