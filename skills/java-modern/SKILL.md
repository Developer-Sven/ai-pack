---
name: java-modern
description: "Modern Java (JDK 21/25 LTS, 26/27): JDK choice, records/sealed/pattern-matching idioms, virtual threads, scoped values, JVM tuning (GC, AOT cache, JFR), Maven/Gradle toolchains and quality gates, Java vulnerabilities. Use when starting, upgrading, tuning or reviewing plain Java code."
metadata:
  author:
    - ki
  verified: 2026-09-18 (JDK 27 GA, Temurin 25.0.4, Maven 3.9.16 / 4.0.0-rc-6, Gradle 9.7.1)
---

# Modern Java (JDK 21 / 25 LTS)

Language, JVM and toolchain knowledge that is framework-independent. Spring specifics live in
`springboot-patterns` (including the 3.5 → 4 migration), `springboot-security`, `springboot-tdd`,
`springboot-verification` and `jpa-patterns`; style rules in `java-coding-standards`.

> Snapshot 2026-09-18. Versions move every six months: re-check `java -version`,
> https://openjdk.org/projects/jdk/ and https://endoflife.date/eclipse-temurin before pinning.

## 1. Which JDK to target

| JDK | Kind | GA | Status on 2026-09-18 |
|---|---|---|---|
| 17 | LTS | 2021-09 | Temurin support to 2027-10. Floor of Spring Boot 4, Spring Framework 7, JUnit 6, Hibernate 7, Jackson 3, Maven 4, Gradle 9 |
| 21 | LTS | 2023-09 | Temurin to 2029-12. **Oracle JDK 21** updates from the Oct 2026 CPU onward are under the OTN licence (no longer free for production) |
| **25** | **LTS** | 2025-09-16 | **Default target.** Temurin to 2031-09. Spring recommends the latest LTS; Boot 4 native images need GraalVM 25 |
| 26 | feature | 2026-03-17 | Superseded — Temurin 26 support ended 2026-09-15 |
| 27 | feature | 2026-09-15 | Newest. Outside Spring Boot 4.1's tested range (17–26), Gradle 9.7 cannot run on it, JaCoCo supports it only from 0.8.16 → experiments only |
| 29 | LTS (expected) | 2027-09 | Next LTS on the two-year cadence |

Rules:
- **New services:** JDK 25 (toolchain / `<release>25</release>`), container image pinned to a
  major (`eclipse-temurin:25-jre`), never `latest`.
- **Libraries:** compile with `--release 17` (or 21) so more consumers can use them; test on 25.
- **Existing 17/21 services:** plan the move to 25 now. On Oracle JDK 21, switch to an OpenJDK
  build (Temurin, Corretto, ...) or upgrade before the October 2026 CPU.
- **Never ship `--enable-preview`** in production artifacts. Preview APIs change every release
  (structured concurrency changed shape in 25, 26 and again in 27). Class files compiled with
  preview features only run on that exact JDK feature release.

## 2. Idioms — prefer the right column, flag the left in reviews

| Old form | Modern form | Since |
|---|---|---|
| DTO/value class with hand-written `equals`/`hashCode`/getters | `record` (validate in the compact constructor) | 16 |
| `if (o instanceof Order) { Order x = (Order) o; ... }` | `if (o instanceof Order x)` / record pattern `o instanceof Order(var id, var total)` | 16 / 21 |
| `if/else` chains or visitor over a closed hierarchy | `sealed interface` + exhaustive `switch` (no `default`) | 17 / 21 |
| `list.get(0)`, `list.get(list.size() - 1)`, manual reverse copies | `getFirst()`, `getLast()`, `reversed()` (`SequencedCollection`, `SequencedMap.firstEntry()`) | 21 |
| unused variable names `ignored`, `e`, `unused` | `_` (`catch (NumberFormatException _)`, `(_, v) -> ...`) | 22 |
| `.collect(Collectors.toList())` | `.toList()` (unmodifiable — do not mutate the result) | 16 |
| hand-rolled windowing/batching or bounded parallel I/O in streams | `stream.gather(Gatherers.windowFixed(n))`, `Gatherers.mapConcurrent(max, fn)` | 24 |
| static helper to validate args before `super(...)` | statements before `super(...)` (flexible constructor bodies) | 25 |
| `ThreadLocal` for request/tenant context | `ScopedValue` (immutable, bounded lifetime) | 25 |
| `Executors.newFixedThreadPool(200)` for blocking I/O | `Executors.newVirtualThreadPerTaskExecutor()` + a `Semaphore` for downstream limits | 21 |
| `/** <p>HTML</p> */` Javadoc | `///` Markdown doc comments (optional) | 23 |
| one-off `public class Tool { public static void main(String[] args) }` | compact source file: `void main() { IO.println(...); }` run with `java Tool.java` | 25 |
| `System.setSecurityManager(...)`, `-Djava.security.manager` | remove — the Security Manager is permanently disabled | 24 |

```java
import java.math.BigDecimal;
import java.time.Instant;

sealed interface PaymentResult permits Approved, Declined, Pending {}
record Approved(String txId, BigDecimal amount) implements PaymentResult {}
record Declined(String reason) implements PaymentResult {}
record Pending(Instant retryAt) implements PaymentResult {}

final class PaymentText {
  static String describe(PaymentResult result) {
    return switch (result) {                    // exhaustive over the sealed type: no default
      case Approved(var tx, var amount) when amount.signum() > 0 -> "paid " + tx;
      case Approved a -> "zero amount " + a.txId();
      case Declined(var reason) -> "declined: " + reason;
      case Pending(var at) -> "retry at " + at;
    };
  }
}
```

A new permitted subtype now breaks compilation at every `switch` that must handle it — that is the
point; do not add `default` to silence it. Full per-release feature map with JEP numbers and more
examples: [references/language-features.md](references/language-features.md).

## 3. Concurrency in one screen

- Virtual threads (JDK 21) make blocking I/O cheap; they do **not** make CPU work faster.
  One virtual thread per task, never pool them. Bound access to scarce resources (DB pool, rate-limited
  APIs) with a `Semaphore` or the pool itself — virtual threads remove the accidental throttle that a
  200-thread pool used to provide.
- Pinning: on JDK 21–23 a virtual thread blocking inside `synchronized` pins its carrier → use
  `ReentrantLock` there. JDK 24+ (JEP 491) fixed that; remaining pinning is native frames and class
  initializers only. Another reason to run 25.
- `ThreadLocal` caches of expensive objects multiply with millions of virtual threads → pass
  explicitly or use `ScopedValue`.
- Structured concurrency is still **preview** in JDK 27 (7th preview) — use
  `newVirtualThreadPerTaskExecutor()` + `invokeAll`/futures with timeouts, or
  `Gatherers.mapConcurrent`, in production.
- Spring Boot: `spring.threads.virtual.enabled=true` (+ `spring.main.keep-alive=true` if only
  scheduled jobs keep the app alive); pool-size properties are then ignored.

Details, code and diagnostics (`jcmd Thread.dump_to_file`, JFR events):
[references/concurrency.md](references/concurrency.md).

## 4. Performance in one screen

- Containers: default max heap is 25 % of the container limit → set `-XX:MaxRAMPercentage=75`
  (leave room for metaspace, threads, direct buffers).
- GC: G1 is right for most services. Up to JDK 26 the JVM silently picks **Serial** with 1 CPU or
  < 1792 MB memory — set `-XX:+UseG1GC` explicitly in small containers (JDK 27 always picks G1,
  JEP 523). ZGC (`-XX:+UseZGC`, generational only since 24) for large heaps with tight pause budgets.
- Startup: JDK 25 AOT cache — training run `-XX:AOTCacheOutput=app.aot`, then `-XX:AOTCache=app.aot`
  (Spring Boot: extract the jar first, train with `-Dspring.context.exit=onRefresh`).
- Memory: compact object headers (`-XX:+UseCompactObjectHeaders`, product in 25, default in 27;
  JEP 534 reports 22 % less heap and 8 % less CPU on SPECjbb2015) — measure with your workload.
- Measure before tuning: JFR (`-XX:StartFlightRecording`), JMH for micro-benchmarks, load tests for
  the rest. Most wins are still N+1 queries, missing indexes, unbounded result sets, missing timeouts
  and per-request object churn.

Flags, GC matrix, JFR recipes, code-level hot spots:
[references/jvm-performance.md](references/jvm-performance.md).

## 5. Build tooling baseline (Sept 2026)

| Tool | Use | Notes |
|---|---|---|
| Maven | **3.9.16** | Maven 4 is still RC (4.0.0-rc-6): needs Java 17, model 4.1.0, `mvnup` upgrade tool — try on a branch, not in production CI |
| Gradle | **9.7.1** | Runs on JDK 17–26; Java 25 since 9.1, 26 since 9.4; configuration cache is the preferred mode |
| Wrappers | `mvnw` (maven-wrapper 3.3.4), `gradlew` | Always commit and use the wrapper; pin JDK via toolchains |
| Lombok | ≥ 1.18.40 (JDK 25), 1.18.46 (26), 1.18.48 (27) | JDK 23+ no longer runs annotation processors found on the classpath: declare them (`annotationProcessorPaths` / `annotationProcessor`) |
| JaCoCo | 0.8.15 (JDK 26 official) | 0.8.14 for 25; JDK 27 needs 0.8.16 |
| Error Prone + NullAway | 2.50.0 + 0.14.1 | Error Prone must run on JDK 21+; pair NullAway with JSpecify `@NullMarked` |
| SpotBugs + FindSecBugs | 4.10.4 + 1.14.0 | security bug patterns (injection, XXE, deserialization, SpEL, path traversal, weak crypto) |
| OWASP dependency-check | 13.0.0 | needs an NVD API key (via `settings.xml` server id — never committed) |
| OSV-Scanner | v2.6.0 | `osv-scanner scan source -r .`; resolves transitive Maven deps; includes malware (`MAL-`) entries |
| OpenRewrite | rewrite-maven-plugin 6.x | `UpgradeToJava25`, `UpgradeSpringBoot_4_0` recipes |

Snippets for all of the above (pom/Gradle, Mockito agent, toolchains, enforcer, CI order):
[references/build-tooling.md](references/build-tooling.md). Lockfiles, cooldowns and malicious-package
response: `supply-chain-security`.

## 6. Security essentials

Never, with untrusted input: `ObjectInputStream.readObject()`, XML parsers with DTDs enabled,
`SpelExpressionParser` + `StandardEvaluationContext`, `InitialContext.lookup()`,
`Runtime.exec`/`ProcessBuilder` through a shell, `Paths.get(base, userInput)` without a
normalize-and-`startsWith` check, `RestClient`/`HttpClient` to user-supplied URLs without an allowlist,
Jackson default typing / `@JsonTypeInfo(use = Id.CLASS)`, string-built SQL/JPQL/Mongo queries or
unvalidated `Sort` properties. Use `SecureRandom` for tokens, `MessageDigest.isEqual` for secret
comparison, `PasswordEncoder` (Argon2/bcrypt) for passwords, AES-GCM with fresh 12-byte IVs.

Vulnerable → fixed code for each class: [references/secure-coding.md](references/secure-coding.md).
Spring Security configuration: `springboot-security`. Deep audits: `security-reviewer`,
`web-security-auditor`, `api-security-auditor`.

## 7. Upgrading 17/21 → 25

1. Toolchain: `maven-compiler-plugin` 3.15+ with `<maven.compiler.release>25</maven.compiler.release>`
   (Spring Boot parent: `<java.version>25</java.version>`) or Gradle ≥ 9.1 with
   `languageVersion = JavaLanguageVersion.of(25)`; CI runners and Docker images on 25.
2. Bytecode tools first: Lombok ≥ 1.18.40, JaCoCo ≥ 0.8.14, SpotBugs 4.10.x, Mockito 5.x current,
   Byte Buddy/ASM-based libraries (Hibernate, Spring) on current patch lines.
3. Annotation processing (JDK 23+): processors must be declared explicitly, otherwise Lombok/MapStruct
   silently stop generating code and the build fails with `cannot find symbol` on getters/builders.
4. Resolve — do not suppress — the runtime warnings: dynamic agent loading (JEP 451 → configure the
   Mockito agent), JNI (`--enable-native-access=ALL-UNNAMED` only for code that needs it, JEP 472),
   `sun.misc.Unsafe` memory access (JEP 498 → upgrade Netty and friends), final-field mutation via
   reflection (JEP 500, JDK 26+ → fix the library or its configuration).
5. Automate: `./mvnw -U org.openrewrite.maven:rewrite-maven-plugin:run -Drewrite.recipeArtifactCoordinates=org.openrewrite.recipe:rewrite-migrate-java:RELEASE -Drewrite.activeRecipes=org.openrewrite.java.migrate.UpgradeToJava25`
6. Scan for removed internals: `jdeps --jdk-internals target/app.jar`, `jdeprscan --release 25 target/app.jar`.
7. Full test suite plus a load test — GC defaults, virtual-thread behaviour and startup change.

## Related

- `java-coding-standards` (style/naming/immutability), `springboot-patterns` (+ Boot 4 migration),
  `springboot-security`, `springboot-tdd`, `springboot-verification`, `jpa-patterns`,
  `backend-performance` (measure-first loop, load tests), `supply-chain-security` (lockfiles, verification)
- Agents: `java-reviewer` (read-only review), `java-build-resolver` (build failures),
  `performance-optimizer`, `security-reviewer`
- Sources: https://openjdk.org/projects/jdk/25/ · https://openjdk.org/projects/jdk/27/ ·
  https://www.oracle.com/java/technologies/java-se-support-roadmap.html ·
  https://maven.apache.org/whatsnewinmaven4.html · https://docs.gradle.org/current/userguide/compatibility.html
