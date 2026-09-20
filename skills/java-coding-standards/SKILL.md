---
name: java-coding-standards
description: "Java style rules: naming, records and immutability, Optional, streams, exceptions, JSpecify null-safety, constructor injection, logging, package layout, test naming. Use when writing or reviewing Java code structure or style; language features and JVM tuning live in java-modern."
metadata:
  origin: ECC
---

# Java Coding Standards

House style for readable, maintainable Java 21/25 code in services (Spring Boot 4) and libraries.
Language features by JDK version and JVM tuning: `java-modern`. Spring architecture: `springboot-patterns`.
Persistence: `jpa-patterns`.

## When to Use

- Writing or reviewing Java code for naming, structure, immutability or error handling
- Reviewing `Optional`, streams, generics, null handling or logging style
- Setting up a new project's package layout, formatter and conventions

## Core Principles

- Clarity over cleverness; small methods with one level of abstraction
- Immutable by default (records, `final` fields, unmodifiable collections)
- Non-null by default; nullability is explicit in the type (JSpecify)
- Fail fast at boundaries with meaningful exceptions; never swallow errors
- Follow the existing project conventions before these defaults

## Naming

```java
public final class OrderService {}                  // classes, records, enums: PascalCase nouns
public record Money(BigDecimal amount, Currency currency) {}
public sealed interface PaymentResult permits Approved, Declined {}

private final OrderRepository orderRepository;      // fields/methods: camelCase; methods are verbs
public Optional<Order> findBySlug(String slug) {}
public boolean isExpired() {}                       // booleans: is/has/can

private static final int MAX_PAGE_SIZE = 100;       // constants: UPPER_SNAKE_CASE
package com.example.billing.invoice;                // packages: lowercase, no underscores

class OrderController {}                            // Spring MVC: *Controller, *Service, *Repository
class OrderServiceTest {}                           // unit tests *Test, integration tests *IT
```

Avoid abbreviations (`custRepo`), Hungarian prefixes, `Impl` for the only implementation (name the
interface for the role, or drop the interface), and `Manager`/`Helper`/`Util` grab-bags.

## Immutability

```java
public record OrderLine(String sku, int quantity, Money price) {
  public OrderLine {
    Objects.requireNonNull(sku, "sku");
    if (quantity <= 0) throw new IllegalArgumentException("quantity must be > 0");
  }
}

public record Order(String id, List<OrderLine> lines) {
  public Order { lines = List.copyOf(lines); }      // defensive, unmodifiable copy
}
```

- DTOs, value objects, events, projections, `@ConfigurationProperties`: records.
- JPA entities are the exception (mutable, no-arg constructor, not records) → `jpa-patterns`.
- Return `List.copyOf(...)`/`Collections.unmodifiableList(...)`, never the internal mutable field.
- `Stream.toList()` is unmodifiable; use `Collectors.toCollection(ArrayList::new)` only when you must mutate.

## Null Handling and Optional

```java
// package-info.java — everything in the package is non-null unless marked
@NullMarked
package com.example.billing;

import org.jspecify.annotations.NullMarked;
```

```java
public @Nullable String findNickname(UserId id) { ... }      // nullable return: explicit
List<@Nullable String> tokens;                                // nullable elements
String @Nullable [] maybeArray;                               // nullable array reference
```

- Use `org.jspecify.annotations` (Spring Framework 7 / Boot 4 use them; `org.springframework.lang`
  annotations are deprecated). NullAway can enforce them at compile time (`java-modern` build tooling).
- `Optional` is for return values of lookups: `findX()` returns `Optional<X>`, `getX()` returns `X` or throws.
- Never `Optional` as field, parameter or collection element; never `optional.get()` without a check —
  use `orElseThrow(() -> new OrderNotFoundException(id))`, `map`, `ifPresentOrElse`.
- Validate external input with Bean Validation (`@NotNull`, `@NotBlank`, `@Size`) at the boundary,
  `Objects.requireNonNull` in constructors.

## Streams

```java
List<String> activeNames = customers.stream()
    .filter(Customer::active)
    .map(Customer::name)
    .toList();

Map<Status, Long> countByStatus = orders.stream()
    .collect(Collectors.groupingBy(Order::status, Collectors.counting()));
```

- Keep pipelines short and side-effect free (no mutation of outside state in `map`/`filter`).
- A loop is fine — prefer it over nested streams or `reduce` gymnastics.
- No `parallelStream()` in request-handling code (shared common pool, I/O blocks it).
- `Collectors.toMap` throws on duplicate keys — pass a merge function when duplicates are possible.

## Exceptions

```java
public final class OrderNotFoundException extends RuntimeException {
  public OrderNotFoundException(String orderId) {
    super("Order not found: " + orderId);
  }
}

try {
  return client.fetch(id);
} catch (IOException e) {
  throw new SupplierUnavailableException("fetch " + id + " failed", e);   // keep the cause
}
```

- Unchecked, domain-specific exceptions for business errors; map them to HTTP centrally
  (`@RestControllerAdvice` + `ProblemDetail`, see `springboot-patterns`).
- Never swallow: no empty `catch`, no `catch (Exception e) { log.warn(...) }` that continues silently.
- Don't log and rethrow — log once where the error is handled.
- `InterruptedException`: restore the flag (`Thread.currentThread().interrupt()`) and stop.
- Resources: always try-with-resources for streams, JDBC, `HttpClient` responses, `ExecutorService` (JDK 19+ is `AutoCloseable`).
- Unused catch parameter: `catch (NumberFormatException _)` (JDK 22+).

## Types, Equality and Time

- No raw types; use bounded generics (`<T extends Identifiable>`) and PECS (`? extends` in, `? super` out).
- Closed hierarchies: `sealed` + exhaustive `switch` without `default` (see `java-modern`).
- `equals`/`hashCode` together, or use a record. `BigDecimal`: compare with `compareTo`, not `equals`
  (`2.0` vs `2.00`); money never as `double`.
- `java.time` only: `Instant` for timestamps, `LocalDate` for dates, `ZoneId` explicit; inject a
  `Clock` instead of calling `Instant.now()` in logic you want to test. No `java.util.Date`/`Calendar`.
- `String.formatted(...)`, text blocks for SQL/JSON in tests; `switch` expressions over if-chains.

## Dependency Injection (Spring)

```java
@Service
public class OrderService {
  private final OrderRepository orders;
  private final Clock clock;

  public OrderService(OrderRepository orders, Clock clock) {   // single constructor: no @Autowired needed
    this.orders = orders;
    this.clock = clock;
  }
}

@ConfigurationProperties("billing")
@Validated
public record BillingProperties(@NotBlank String currency, @Positive int maxPageSize, Duration cacheTtl) {}
```

- Constructor injection only; `final` fields; no `@Autowired` fields, no setter injection.
- No mutable instance state in singletons (`@Service`, `@Component`) — they are shared across threads.
- No static mutable state or static service locators.
- Circular dependency = design smell; split the responsibility instead of `@Lazy`.

## Project Structure

Small services can stay layered; grow by **feature** so each package owns its controller, service,
repository and DTOs and exposes as little as possible (package-private by default):

```
src/main/java/com/example/shop/
  ShopApplication.java
  order/        OrderController, OrderService, OrderRepository, Order (entity), dto/…
  payment/      …
  common/       error handling, config, security
src/main/resources/application.yml
src/test/java/com/example/shop/order/…   (mirrors main)
```

Enforce boundaries with ArchUnit (`com.tngtech.archunit:archunit-junit5` 1.5.x) or Spring Modulith
when the codebase grows.

## Logging

```java
private static final Logger log = LoggerFactory.getLogger(OrderService.class);

log.info("order_placed orderId={} total={}", order.id(), order.total());
log.atWarn().addKeyValue("orderId", id).log("payment_retry");        // SLF4J 2 key-value → structured JSON
log.error("order_failed orderId={}", id, ex);                          // exception as last argument
```

- Parameterized messages, never string concatenation; no `System.out`/`printStackTrace`.
- Never log secrets, tokens, passwords, full request bodies or personal data.
- Spring Boot: `logging.structured.format.console=ecs` (or `logstash`, `gelf`) for JSON logs.

## Formatting and Style

- Formatter enforced in the build (Spotless with google-java-format or palantir-java-format), not by review.
- One top-level type per file; member order: constants, fields, constructors, public, package, private.
- `var` when the type is obvious from the right-hand side; spell it out otherwise.
- Methods > ~30 lines or > 3 levels of nesting → extract; early returns over deep nesting.
- Magic numbers/strings → named constants or configuration properties.

## Code Smells to Flag

- Long parameter lists (> 4) → parameter record/builder
- Boolean flag parameters (`send(msg, true)`) → two methods or an enum
- Returning `null` collections → return empty collections
- Catch-and-ignore, catch `Throwable`, exceptions for control flow
- `instanceof` + cast chains where pattern matching or polymorphism fits
- Static mutable state, singletons via static fields
- God classes (`*Manager`, `*Util` with dozens of unrelated methods)
- Commented-out code, TODOs without an issue reference

## Testing Expectations

- JUnit 6 (Jupiter API unchanged from 5) + AssertJ + Mockito 5; details in `springboot-tdd`.
- Test names describe behaviour: `placeOrder_rejectsEmptyCart()` or `@DisplayName`.
- Unit tests: `@ExtendWith(MockitoExtension.class)`, no Spring context.
- Spring slices: `@WebMvcTest`, `@DataJpaTest`, `@DataMongoTest`; replace beans with `@MockitoBean`
  (`@MockBean` was removed in Spring Boot 4).
- Deterministic: inject `Clock`, no `Thread.sleep` (use Awaitility), no dependency on test order.

**Remember**: the compiler and the formatter enforce what they can; reviews focus on intent,
correctness and boundaries.
