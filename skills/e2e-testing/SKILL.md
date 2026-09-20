---
name: e2e-testing
description: "Playwright Test 1.63 E2E suites: role-based locators, web-first assertions, page objects, storageState auth per role, allowed/denied permission paths, axe scans, CI sharding, traces and flaky-test handling. Use when writing or maintaining Playwright tests or fixing flaky E2E runs."
metadata:
  origin: ECC
  customized: ki 2026-09-18 (Playwright 1.63 best practices, no networkidle, storageState auth, axe, current CI)
---

# E2E Testing Patterns (Playwright Test)

Patterns for stable, fast, maintainable E2E suites with `@playwright/test` (current 1.63, 2026-09).

**Lane split:** this skill covers a *committed test suite*. For a quick one-off check that a local page works
(screenshots, console logs, no suite), use `webapp-testing`. For agent-driven exploratory browsing, the
`playwright-cli` skill, `agent-browser` or the Playwright MCP are tools, not test suites.

## Test File Organization

```
tests/
├── e2e/
│   ├── auth.setup.ts          # logs in once, writes storageState
│   ├── dashboard/
│   │   ├── settings.spec.ts
│   │   └── permissions.spec.ts
│   └── public/
│       └── landing.spec.ts
├── pages/                     # page objects
│   └── SettingsPage.ts
└── fixtures.ts                # custom fixtures (axe, test data)
playwright.config.ts
```

## Locators: what users see first

Priority (Playwright best practices): `getByRole` > `getByLabel` > `getByPlaceholder` / `getByText` > `getByTestId` >
CSS/XPath (avoid). Role-based locators double as an accessibility check: if you cannot find it by role and name, neither can a screen reader.

```typescript
page.getByRole('button', { name: 'Save changes' })
page.getByLabel('Log channel')
page.getByRole('row', { name: /ticket #42/i }).getByRole('button', { name: 'Close' })
page.getByTestId('guild-switcher')      // only when there is no accessible name to target
```

New in 1.63: `locator.visible()` narrows to visible matches, and `page.frameLocator()` without a selector searches all frames.

## Web-first assertions and waiting

```typescript
await expect(page.getByRole('status')).toHaveText('Saved')      // auto-retries until timeout
await expect(page.getByRole('listitem')).toHaveCount(3)
await expect(page).toHaveURL(/\/dashboard\/settings$/)
```

- Never `page.waitForTimeout(ms)`. Never `waitForLoadState('networkidle')`: Playwright marks it **DISCOURAGED** for
  testing. Assert on the UI state that proves readiness instead
- Wait for a specific response only when the UI gives no signal:
  `const resp = page.waitForResponse(r => r.url().endsWith('/api/settings') && r.request().method() === 'PUT')`,
  then click, then `await resp`
- Actions (`click`, `fill`) auto-wait for visible, stable, enabled elements. `isVisible()` does not wait, so never branch on it

## Page Object Model

```typescript
// tests/pages/SettingsPage.ts
import { type Page, type Locator, expect } from '@playwright/test'

export class SettingsPage {
  readonly logChannel: Locator
  readonly save: Locator
  readonly status: Locator

  constructor(readonly page: Page) {
    this.logChannel = page.getByLabel('Log channel')
    this.save = page.getByRole('button', { name: 'Save changes' })
    this.status = page.getByRole('status')
  }

  async goto(guildId: string) {
    await this.page.goto(`/dashboard/${guildId}/settings`)
    await expect(this.page.getByRole('heading', { name: 'Settings' })).toBeVisible()
  }

  async setLogChannel(name: string) {
    await this.logChannel.selectOption({ label: name })
    await this.save.click()
    await expect(this.status).toHaveText('Saved')
  }
}
```

## Authentication once, reused (setup project + storageState)

```typescript
// tests/e2e/auth.setup.ts
import { test as setup, expect } from '@playwright/test'
const authFile = 'playwright/.auth/admin.json'   // gitignore playwright/.auth/

setup('authenticate as admin', async ({ page }) => {
  await page.goto('/login')
  await page.getByLabel('Email').fill(process.env.E2E_ADMIN_EMAIL!)
  await page.getByLabel('Password').fill(process.env.E2E_ADMIN_PASSWORD!)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
  await page.context().storageState({ path: authFile })
})
```

- **OAuth dashboards (Discord login):** do not drive discord.com in tests (bot detection, rate limits). Use a test-only
  login route that exists **only** when `NODE_ENV === 'test'` and is covered by a test that it 404s in production,
  or inject a session cookie signed with the test secret into `storageState`
- Credentials come from env/CI secrets, never from the repo. `storageState` files contain live session cookies,
  so keep them out of git and artifacts
- One storage state per role (admin, member, anonymous). Test that the member **cannot** reach admin routes and API
  endpoints (403), not only that the button is hidden

## Playwright Configuration

```typescript
// playwright.config.ts
import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [['html', { open: 'never' }], ['junit', { outputFile: 'results/junit.xml' }]] : 'list',
  use: {
    baseURL: process.env.BASE_URL ?? 'http://localhost:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    { name: 'setup', testMatch: /.*\.setup\.ts/ },
    { name: 'chromium', use: { ...devices['Desktop Chrome'], storageState: 'playwright/.auth/admin.json' }, dependencies: ['setup'] },
    { name: 'mobile', use: { ...devices['Pixel 7'], storageState: 'playwright/.auth/admin.json' }, dependencies: ['setup'] },
  ],
  webServer: {
    command: 'npm run build && npm run start',   // test the production build, not `dev`
    url: 'http://localhost:3000',
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
})
```

Add `firefox`/`webkit` projects when the audience needs them. Since 1.57 Playwright runs Chrome for Testing builds.

## Accessibility scan per page

```typescript
// tests/fixtures.ts
import { test as base, expect } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

export const test = base.extend<{ axe: () => AxeBuilder }>({
  axe: async ({ page }, use) => {
    await use(() => new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']))
  },
})
export { expect }

// usage
test('settings page has no WCAG A/AA violations', async ({ page, axe }) => {
  await page.goto('/dashboard/123/settings')
  const { violations } = await axe().analyze()
  expect(violations).toEqual([])
})
```

Automated scans find roughly a third of WCAG issues. Keep keyboard-only journeys as tests too (Tab order, Escape closes dialogs, focus returns).

## Network control

```typescript
await page.route('**/api/discord/guilds', route =>
  route.fulfill({ json: [{ id: '123', name: 'Test Guild', permissions: '8' }] }))
```

Mock third-party APIs (Discord, payment providers). Do not mock your own backend in E2E; that is what component tests are for.

## API integration tests (below the browser)

Most permission and data bugs are cheaper to catch at the HTTP layer than in Playwright: start the
real app in-process, hit it with `supertest` (Node) or `httpx.AsyncClient(transport=ASGITransport(app))`
(Python, see `python-testing`), and back it with a **real database** - PGlite in-process for
Postgres, Testcontainers (`@testcontainers/postgresql`, `mysql`, `mongodb`) in CI
(`data-layer/references/test-databases.md`). Cover per endpoint: 401 without a session, 422 for
unknown keys (mass assignment), 404 for another tenant's id, 409 for conflicts, and the happy path.
Keep Playwright for flows that need the browser.

Tested 2026-09 (Express 5.2, supertest 7.2, PGlite 0.5.8, Node 24.19; 2/2 green):

```ts
// api.test.ts - HTTP-level integration test: real Express app, real Postgres (PGlite here, Testcontainers in CI).
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { z } from 'zod';
import { ConflictError, NotFoundError, type NoteRepo } from './note-repo.ts';
import { PG_SCHEMA, pgNoteRepo } from './pg-note-repo.ts';

function buildApp(notes: NoteRepo) {
  const app = express();
  app.use(express.json({ limit: '32kb' }));
  app.use((req: Request, res: Response, next: NextFunction) => {
    const user = req.get('x-test-user'); // stand-in for the session middleware
    if (!user) return void res.status(401).json({ error: 'unauthenticated' });
    res.locals.userId = user;
    next();
  });
  const NoteIn = z.strictObject({ slug: z.string().regex(/^[a-z0-9-]{1,80}$/), title: z.string().min(1).max(200), body: z.string().max(10_000).default('') });
  app.post('/notes', async (req, res) => {
    const input = NoteIn.parse(req.body);
    res.status(201).json(await notes.create({ ...input, ownerId: res.locals.userId }));
  });
  app.get('/notes/:id', async (req, res) => {
    const id = z.uuid().safeParse(req.params.id); // malformed ids are "not found", not a DB error
    const note = id.success ? await notes.get(res.locals.userId, id.data) : null;
    if (!note) return void res.status(404).json({ error: 'not found' });
    res.json(note);
  });
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof z.ZodError) return void res.status(422).json({ error: 'invalid', issues: err.issues.map((i) => i.path.join('.')) });
    if (err instanceof ConflictError) return void res.status(409).json({ error: 'conflict' });
    if (err instanceof NotFoundError) return void res.status(404).json({ error: 'not found' });
    res.status(500).json({ error: 'internal' }); // never the driver message
  });
  return app;
}

let pg: PGlite;
let app: ReturnType<typeof buildApp>;
before(async () => {
  pg = await PGlite.create();
  await pg.exec(PG_SCHEMA); // real projects: run the migration files
  app = buildApp(pgNoteRepo(pg));
});
beforeEach(() => pg.exec('TRUNCATE notes')); // or fresh tenant ids per test
after(() => pg.close());

test('POST /notes: 401 without session, 201, 409 on duplicate slug, 422 on mass assignment', async () => {
  await request(app).post('/notes').send({ slug: 'a', title: 'A' }).expect(401);
  const created = await request(app).post('/notes').set('x-test-user', 'alice').send({ slug: 'a', title: 'A' }).expect(201);
  assert.equal(created.body.ownerId, 'alice');
  await request(app).post('/notes').set('x-test-user', 'alice').send({ slug: 'a', title: 'B' }).expect(409);
  const bad = await request(app).post('/notes').set('x-test-user', 'alice').send({ slug: 'b', title: 'B', ownerId: 'bob' }).expect(422);
  assert.deepEqual(bad.body, { error: 'invalid', issues: [''] }, 'unknown key rejected by the strict schema');
});

test('GET /notes/:id: another user gets 404, not 403 (no existence oracle)', async () => {
  const { body } = await request(app).post('/notes').set('x-test-user', 'alice').send({ slug: 'x', title: 'X' }).expect(201);
  await request(app).get(`/notes/${body.id}`).set('x-test-user', 'alice').expect(200);
  await request(app).get(`/notes/${body.id}`).set('x-test-user', 'mallory').expect(404);
  await request(app).get('/notes/not-a-uuid').set('x-test-user', 'alice').expect(404);
});
```

The repository (`pgNoteRepo`) and its contract suite are in `data-layer/references/store-adapter.md`.

## Flaky Test Handling

```bash
npx playwright test tests/e2e/dashboard --repeat-each=10 --workers=4   # reproduce
npx playwright test --last-failed                                       # iterate on failures
npx playwright show-trace test-results/**/trace.zip                     # inspect
```

- Root causes, in order of frequency: shared state between tests, `isVisible()`-style checks without waiting,
  animation/transition timing (assert the end state, or use `reducedMotion: 'reduce'` in `use`), and time-dependent data (fix the clock with `page.clock`)
- Quarantine with a tracked reason, never silently: `test.fixme(true, 'flaky: #123 race on toast')`
- 1.62: `retryStrategy: 'isolated'` re-runs failures sequentially at the end, which separates flakiness from parallelism issues
- 1.63: named test locks for tests sharing one external resource

## Next.js specifics

- Test `next build && next start`, not `next dev`. Dev compiles on demand and has different timing
- Next 16.3 `@next/playwright` `instant(page, fn)` (experimental, needs Cache Components) asserts what a navigation shows instantly
- Async Server Components and Server Actions have no unit-test story in RTL, so their behaviour belongs here (see `nextjs-patterns`)

## CI/CD Integration

```yaml
# .github/workflows/e2e.yml (pin third-party actions to a commit SHA; see supply-chain-security)
name: E2E
on: [push, pull_request]
jobs:
  e2e:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with: { node-version: 24, cache: npm }
      - run: npm ci
      - run: npx playwright install --with-deps chromium
      - run: npx playwright test
        env:
          E2E_ADMIN_EMAIL: ${{ secrets.E2E_ADMIN_EMAIL }}
          E2E_ADMIN_PASSWORD: ${{ secrets.E2E_ADMIN_PASSWORD }}
      - uses: actions/upload-artifact@v7
        if: ${{ !cancelled() }}
        with: { name: playwright-report, path: playwright-report/, retention-days: 14 }
```

Traces and videos can contain session cookies and personal data. Keep retention short and the repo private.

## Agents and tooling

- Playwright Test Agents (planner, generator, healer): `npx playwright init-agents --loop=claude` writes agent
  definitions into the project. Review generated tests like any other code
- `npx playwright codegen <url>` records role-based locators; tidy them into page objects
- `npx playwright test --ui` for local debugging; `--debug` for the inspector

## Test Report Template

```markdown
# E2E Test Report (YYYY-MM-DD)
Status: PASSING | FAILING, Total X, Passed Y, Failed Z, Flaky F, Skipped S, Duration Nm
## Failures
- tests/e2e/dashboard/settings.spec.ts:42, "log channel saves": expected status "Saved", got "Error 403".
  Trace: test-results/.../trace.zip. Likely cause: ...
```

## Related

- Skills: `webapp-testing` (ad-hoc local verification), `react-testing` (component tests), `accessibility`, `nextjs-patterns`
- Agents: `e2e-runner` (runs and maintains suites), `a11y-architect`
