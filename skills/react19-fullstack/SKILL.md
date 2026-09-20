---
name: react19-fullstack
description: "Idiomatic React 19 and Next.js 15/16 action lifecycle patterns: Server Actions security, useActionState, useOptimistic, use(), and React Compiler compliance. Use when building or reviewing modern React 19 and Next.js fullstack applications."
---

# React 19 & Next.js 15/16 Fullstack Architecture

Modern fullstack React leverages React 19 primitives (`useActionState`, `useOptimistic`, `use()`) alongside Next.js async request APIs and rigorous Server Actions security.

---

## 1. Next.js 15/16 Async Request APIs

In Next.js 15+, `cookies()`, `headers()`, `params`, and `searchParams` are asynchronous to enable Partial Prerendering (PPR).

```tsx
// app/dashboard/[tenantId]/page.tsx
import { cookies, headers } from 'next/headers';

interface PageProps {
  params: Promise<{ tenantId: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

export default async function TenantPage({ params, searchParams }: PageProps) {
  // MUST await params and searchParams
  const { tenantId } = await params;
  const search = await searchParams;

  // MUST await cookies() and headers()
  const cookieStore = await cookies();
  const session = cookieStore.get('session')?.value;

  const headerList = await headers();
  const userAgent = headerList.get('user-agent');

  return <div>Tenant: {tenantId}</div>;
}
```

### React 19 `use()` in Client Components
```tsx
'use client';
import { use } from 'react';

export function TenantHeader({ paramsPromise }: { paramsPromise: Promise<{ tenantId: string }> }) {
  const { tenantId } = use(paramsPromise);
  return <h2>Active: {tenantId}</h2>;
}
```

---

## 2. Server Actions Security Model

1. **Public POST Endpoints**: Every export in a `'use server'` file becomes a publicly callable POST endpoint.
2. **Mandatory In-Action Authorization**: Middleware does NOT protect Server Actions. Always authenticate and verify ownership inside the action.
3. **Zod Validation**: Validate all inputs (`FormData` or arguments).
4. **Data Access Layer (DAL) Boundary**: Actions must call a `server-only` DAL and return safe DTOs.

```ts
// app/actions/update-user.ts
'use server';

import 'server-only';
import { z } from 'zod';
import { cookies } from 'next/headers';
import { verifyAuthSession } from '@/data/auth';
import { updateUserInDb } from '@/data/user-dal';

const UpdateUserSchema = z.object({
  userId: z.string().uuid(),
  displayName: z.string().min(2).max(50),
});

export type ActionResponse = {
  success: boolean;
  error?: string;
  fieldErrors?: Record<string, string[]>;
};

export async function updateUserAction(
  _prevState: ActionResponse,
  formData: FormData
): Promise<ActionResponse> {
  const parsed = UpdateUserSchema.safeParse({
    userId: formData.get('userId'),
    displayName: formData.get('displayName'),
  });

  if (!parsed.success) {
    return {
      success: false,
      error: 'Validation failed',
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }

  const cookieStore = await cookies();
  const token = cookieStore.get('session')?.value;
  const currentUser = await verifyAuthSession(token);

  if (!currentUser || currentUser.id !== parsed.data.userId) {
    return { success: false, error: 'Unauthorized' };
  }

  try {
    await updateUserInDb(parsed.data);
    return { success: true };
  } catch (err) {
    console.error('Update error:', err);
    return { success: false, error: 'Internal server error' };
  }
}
```

---

## 3. React 19 State: `useActionState` & `useOptimistic`

`useFormState` is deprecated in favor of `useActionState`.

```tsx
// app/users/[id]/edit-form.tsx
'use client';

import { useActionState, useOptimistic, startTransition } from 'react';
import { updateUserAction, ActionResponse } from '@/app/actions/update-user';

interface User {
  id: string;
  displayName: string;
}

export function EditUserForm({ user }: { user: User }) {
  const initialState: ActionResponse = { success: false };
  const [state, formAction, isPending] = useActionState(updateUserAction, initialState);

  const [optimisticUser, setOptimisticUser] = useOptimistic(
    user,
    (current, update: Partial<User>) => ({ ...current, ...update })
  );

  async function handleSubmit(formData: FormData) {
    const newName = formData.get('displayName') as string;

    startTransition(() => {
      setOptimisticUser({ displayName: newName });
    });

    formAction(formData);
  }

  return (
    <form action={handleSubmit}>
      <input type="hidden" name="userId" value={user.id} />
      <h3>Editing: {optimisticUser.displayName}</h3>

      <div>
        <label htmlFor="displayName">Name</label>
        <input
          id="displayName"
          name="displayName"
          defaultValue={user.displayName}
          disabled={isPending}
        />
        {state.fieldErrors?.displayName && (
          <span className="error">{state.fieldErrors.displayName[0]}</span>
        )}
      </div>

      <button type="submit" disabled={isPending}>
        {isPending ? 'Saving...' : 'Save Profile'}
      </button>
    </form>
  );
}
```

---

## 4. React Compiler Compliance

- Do NOT manually add `useMemo` or `useCallback` when React Compiler is enabled; it optimizes component renders automatically.
- Adhere strictly to the Rules of React: never mutate props or state objects directly, always treat values as immutable.
