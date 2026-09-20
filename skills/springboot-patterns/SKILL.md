---
name: springboot-patterns
description: "Spring Boot 4 (Framework 7) service patterns: starters, REST controllers, validation, ProblemDetail, RestClient/HTTP service clients, API versioning, @Retryable, caching, virtual threads, config, observability, 3.5-to-4 migration. Use when building, reviewing or upgrading a Spring Boot backend."
metadata:
  origin: ECC
---

# Spring Boot Development Patterns

Architecture and API patterns for production Spring Boot services. Baseline: **Spring Boot 4.1.x**
(Framework 7.0, Security 7.1, Hibernate 7.4, Jackson 3, Tomcat 11) on **JDK 25**.
Boot 4.0 OSS support ends 2026-12-31; **Boot 3.5 OSS support ended 2026-06-30** — upgrading is
covered in [references/boot4-migration.md](references/boot4-migration.md).

Related: `springboot-security` (auth, CSRF, headers, rate limits), `springboot-tdd` (tests),
`springboot-verification` (release gate), `jpa-patterns` (persistence), `java-modern` (JDK, JVM,
build tooling), `java-coding-standards` (style).

## When to Activate

- Building REST APIs with Spring MVC (or WebFlux for streaming/reactive stacks)
- Structuring controller → service → repository, DTOs and validation
- Calling other HTTP services, adding retries, caching, async or scheduled work
- Configuring profiles, properties, observability and production defaults
- Upgrading from Spring Boot 3.x

## Starters (Boot 4 names)

```xml
<parent>
  <groupId>org.springframework.boot</groupId>
  <artifactId>spring-boot-starter-parent</artifactId>
  <version>4.1.1</version>
</parent>
<properties><java.version>25</java.version></properties>
<dependencies>
  <dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-webmvc</artifactId></dependency>
  <dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-validation</artifactId></dependency>
  <dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-actuator</artifactId></dependency>
  <dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-restclient</artifactId></dependency>
  <!-- data: spring-boot-starter-data-jpa + spring-boot-starter-flyway, or spring-boot-starter-data-mongodb -->
  <!-- tests: spring-boot-starter-webmvc-test, spring-boot-starter-data-jpa-test, spring-boot-testcontainers -->
</dependencies>
```

`spring-boot-starter-web` still resolves but is deprecated; Undertow is gone (Tomcat 11 or Jetty 12.1).

## REST Controller

```java
@RestController
@RequestMapping("/api/orders")
class OrderController {
  private final OrderService orders;

  OrderController(OrderService orders) { this.orders = orders; }

  @GetMapping
  Page<OrderResponse> list(@PageableDefault(size = 20, sort = "createdAt") Pageable pageable) {
    return orders.list(pageable).map(OrderResponse::from);        // max size capped by spring.data.web.pageable.max-page-size
  }

  @GetMapping("/{id}")
  OrderResponse get(@PathVariable long id) {
    return OrderResponse.from(orders.get(id));                     // service throws OrderNotFoundException → 404
  }

  @PostMapping
  ResponseEntity<OrderResponse> create(@Valid @RequestBody CreateOrderRequest request, UriComponentsBuilder uri) {
    Order created = orders.create(request);
    return ResponseEntity.created(uri.path("/api/orders/{id}").build(created.id()))
        .body(OrderResponse.from(created));
  }
}

public record CreateOrderRequest(
    @NotBlank @Size(max = 64) String customerRef,
    @NotEmpty @Size(max = 100) List<@Valid LineRequest> lines) {}

public record LineRequest(@NotBlank @Size(max = 40) String sku, @Positive @Max(1000) int quantity) {}

public record OrderResponse(long id, String status, BigDecimal total) {
  static OrderResponse from(Order o) { return new OrderResponse(o.id(), o.status().name(), o.total()); }
}
```

- Controllers stay thin: validate, delegate, map. No entities in request/response bodies (mass
  assignment, lazy-loading leaks, accidental field exposure).
- Every collection in a request has `@Size(max=…)`; every list endpoint is paginated and capped.
- Sort properties from `Pageable` are user input: allowlist them before they reach a query (`jpa-patterns`).

## Error Handling (RFC 9457 ProblemDetail)

```java
@RestControllerAdvice
class ApiExceptionHandler extends ResponseEntityExceptionHandler {   // handles MVC/validation exceptions as ProblemDetail
  private static final Logger log = LoggerFactory.getLogger(ApiExceptionHandler.class);

  @ExceptionHandler(OrderNotFoundException.class)
  ProblemDetail notFound(OrderNotFoundException ex) {
    return ProblemDetail.forStatusAndDetail(HttpStatus.NOT_FOUND, ex.getMessage());
  }

  @ExceptionHandler(ObjectOptimisticLockingFailureException.class)
  ProblemDetail conflict() {
    return ProblemDetail.forStatusAndDetail(HttpStatus.CONFLICT, "Resource was modified, reload and retry");
  }

  @ExceptionHandler(Exception.class)
  ProblemDetail unexpected(Exception ex, HttpServletRequest request) {
    String incident = UUID.randomUUID().toString();
    log.error("unhandled_error incident={} path={}", incident, request.getRequestURI(), ex);
    ProblemDetail pd = ProblemDetail.forStatusAndDetail(HttpStatus.INTERNAL_SERVER_ERROR, "Internal error");
    pd.setProperty("incident", incident);                              // no stack trace, no exception message
    return pd;
  }
}
```

`spring.mvc.problemdetails.enabled=true` makes the framework's own errors ProblemDetail too. Keep
`server.error.include-message`/`include-stacktrace`/`include-binding-errors` at their `never` defaults.
`AccessDeniedException`/`AuthenticationException` are handled by Spring Security's filters — don't
catch them into 500s.

## Outbound HTTP

```java
// Declarative client (Framework 7 / Boot 4)
public interface InventoryClient {
  @GetExchange("/items/{sku}")
  Item item(@PathVariable String sku);
}

@SpringBootApplication
@ImportHttpServices(group = "inventory", types = InventoryClient.class)
public class ShopApplication {}
```

```properties
# global defaults for all clients
spring.http.clients.connect-timeout=2s
spring.http.clients.read-timeout=5s
spring.http.serviceclient.inventory.base-url=https://inventory.internal
spring.http.serviceclient.inventory.read-timeout=3s
```

- Imperative code: `RestClient` (inject `RestClient.Builder`); `RestTemplate` is in maintenance.
- Always timeouts; never forward user-controlled URLs without allowlisting (SSRF — Boot 4.1
  `InetAddressFilter`, see `java-modern/references/secure-coding.md`).

## Resilience (Framework 7, replaces Spring Retry)

```java
@Configuration
@EnableResilientMethods
class ResilienceConfig {}

@Service
class PaymentGateway {
  @Retryable(includes = TransientPaymentException.class, maxRetries = 3,
             delay = 200, multiplier = 2, jitter = 50, maxDelay = 2000)
  public Receipt charge(ChargeRequest request) { ... }             // must be idempotent (idempotency key)

  @ConcurrencyLimit(10)                                            // bulkhead: max 10 concurrent calls
  public Quote quote(String sku) { ... }
}
```

Programmatic: `new RetryTemplate(RetryPolicy.builder().maxRetries(3).delay(Duration.ofMillis(200)).build())`.
Retry only idempotent operations and transient errors (timeouts, 503) — never 4xx or validation errors.
Circuit breakers still need Resilience4j.

## API Versioning (Boot 4)

```properties
spring.mvc.apiversion.use.header=X-API-Version
spring.mvc.apiversion.default=1.0
spring.mvc.apiversion.supported=1.0,1.1,2.0
```

```java
@GetMapping(path = "/{id}", version = "1.0")  OrderV1 getV1(@PathVariable long id) { ... }
@GetMapping(path = "/{id}", version = "2.0+") OrderV2 getV2(@PathVariable long id) { ... }   // 2.0 and later
```

Unsupported versions return 400; deprecation hints (`Deprecation`/`Sunset` headers) via
`StandardApiVersionDeprecationHandler`.

## Caching

```properties
spring.cache.type=caffeine
spring.cache.caffeine.spec=maximumSize=10000,expireAfterWrite=10m
```

```java
@Cacheable(cacheNames = "product", key = "#tenantId + ':' + #id")   // tenant/user in the key for scoped data
public ProductView product(String tenantId, long id) { ... }

@CacheEvict(cacheNames = "product", key = "#tenantId + ':' + #id")
public void update(String tenantId, long id, ProductUpdate update) { ... }
```

`@EnableCaching` required. Never unbounded caches; never cache per-user data under a global key;
self-invocation bypasses the cache proxy (same as `@Transactional`).

## Concurrency, Async and Scheduling

```properties
# Tomcat requests, @Async, @Scheduled on virtual threads (JDK 21+, 24+ recommended)
spring.threads.virtual.enabled=true
# when only schedulers keep the app alive
spring.main.keep-alive=true
spring.task.execution.simple.concurrency-limit=200
```

- With virtual threads, pool-size properties are ignored — bound downstream access (Hikari pool,
  `@ConcurrencyLimit`, `Semaphore`) instead. Details: `java-modern/references/concurrency.md`.
- `@Async` methods return `CompletableFuture`/`void`, are `public`, and are called from another bean;
  exceptions in `void` methods go to `AsyncUncaughtExceptionHandler` — register one.
- `@Scheduled` in multi-instance deployments runs on every instance: guard with a distributed lock
  (e.g. ShedLock) and keep jobs idempotent.

## Configuration

```java
@ConfigurationProperties("shop.orders")
@Validated
public record OrderProperties(@NotNull Duration paymentTimeout, @Positive @Max(500) int maxLines) {}
```

- Register with `@ConfigurationPropertiesScan`; inject the record, not `@Value` strings.
- Profiles for environment differences (`application-prod.yml`); secrets only via environment,
  `spring.config.import=optional:configtree:/run/secrets/`, or Vault — never committed YAML.
- Every property you add must be read somewhere (no dead settings).

## Observability and Production Defaults

```properties
management.endpoints.web.exposure.include=health,info,prometheus
# liveness/readiness (on by default in Boot 4)
management.endpoint.health.probes.enabled=true
# JSON logs with MDC + SLF4J key-values
logging.structured.format.console=ecs
spring.jpa.open-in-view=false
# default; tune spring.lifecycle.timeout-per-shutdown-phase
server.shutdown=graceful
server.compression.enabled=true
```

- Metrics/traces: Micrometer + `spring-boot-starter-opentelemetry` (OTLP export).
- Correlation: tracing IDs flow into logs automatically with Micrometer Tracing; add business IDs
  with `log.atInfo().addKeyValue(...)`.
- Actuator on a separate port (`management.server.port`) or behind authentication; never expose
  `env`, `heapdump`, `threaddump`, `loggers` publicly (`springboot-security`).

## Filters

```java
@Component
class RequestTimingFilter extends OncePerRequestFilter {
  private static final Logger log = LoggerFactory.getLogger(RequestTimingFilter.class);

  @Override
  protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res, FilterChain chain)
      throws ServletException, IOException {
    long start = System.nanoTime();
    try {
      chain.doFilter(req, res);
    } finally {
      log.info("http_request method={} path={} status={} durationMs={}", req.getMethod(),
          req.getRequestURI(), res.getStatus(), (System.nanoTime() - start) / 1_000_000);
    }
  }
}
```

Log the path, never the query string or body (tokens and personal data end up there). Prefer
Micrometer's `http.server.requests` metrics for latency; use filters for cross-cutting concerns
only. Rate limiting: `springboot-security`.

## Anti-patterns to Flag

- Field injection, mutable state in singletons, `new` of Spring-managed collaborators
- Entities as API bodies; unbounded `findAll()` endpoints
- `@Transactional`/`@Cacheable`/`@Async` on private methods or self-invoked methods
- HTTP clients without timeouts; retries on non-idempotent calls; hand-written retry loops with
  `Thread.sleep`
- Catch-all handlers that return exception messages or stack traces
- `RestTemplate` in new code; `spring-boot-starter-web`/`@MockBean` in Boot 4 projects
- Blocking calls inside WebFlux/reactor pipelines

**Remember**: thin controllers, explicit DTOs, bounded everything (pages, bodies, pools, retries,
caches, timeouts), and errors handled in one place.
