---
name: fastify-schema
description: High-throughput, schema-first Node.js microservice architecture with Fastify, utilizing Type Providers (TypeBox / Zod) for compile-time and runtime type safety, automated OpenAPI generation, and fast JSON serialization.
---

# Fastify Schema-First & TypeBox Patterns

Fastify achieves industry-leading throughput in Node.js through compiled schema validation (Ajv) and high-speed JSON serialization (fast-json-stringify).

---

## 1. TypeBox vs Zod in Fastify

| Feature | TypeBox (`@fastify/type-provider-typebox`) | Zod (`fastify-type-provider-zod`) |
|---|---|---|
| **Underlying Standard** | Direct JSON Schema generation | Zod schema translated to JSON Schema |
| **Performance** | **Maximum** (Direct JIT compilation) | High, slight conversion overhead |
| **OpenAPI / Swagger** | 1:1 Native representation | Requires conversion plugins |
| **Best For** | High-throughput APIs, microservices | Shared schemas with React/Next frontend |

---

## 2. High-Performance Fastify with TypeBox

```ts
import Fastify from 'fastify';
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';

const app = Fastify({ logger: true }).withTypeProvider<TypeBoxTypeProvider>();

const UserParams = Type.Object({
  userId: Type.String({ format: 'uuid' }),
});

const UserResponse = Type.Object({
  id: Type.String(),
  username: Type.String(),
  role: Type.Union([Type.Literal('admin'), Type.Literal('member')]),
});

const ErrorResponse = Type.Object({
  statusCode: Type.Number(),
  message: Type.String(),
});

app.get(
  '/users/:userId',
  {
    schema: {
      params: UserParams,
      response: {
        200: UserResponse,
        404: ErrorResponse,
      },
    },
  },
  async (request, reply) => {
    // request.params is statically typed: { userId: string }
    const { userId } = request.params;
    const user = await findUser(userId);

    if (!user) {
      return reply.code(404).send({ statusCode: 404, message: 'User not found' });
    }

    return reply.code(200).send({
      id: user.id,
      username: user.name,
      role: user.role,
    });
  }
);
```

---

## 3. Best Practices & Anti-Patterns

1. **Provide Response Schemas**: Always declare `schema.response[200]`. Without response schemas, Fastify falls back to slow `JSON.stringify` instead of compiled serialization.
2. **Encapsulate with Plugins**: Use `fastify-plugin` (`fp`) to register routes, hooks, and decorators across modular feature folders.
3. **No Unchecked Casts**: Never write `request.body as UserInput`. Rely strictly on types inferred by the Type Provider from your schema.
4. **Automated Swagger**: Pair with `@fastify/swagger` and `@fastify/swagger-ui` to generate OpenAPI documentation directly from route schemas.
