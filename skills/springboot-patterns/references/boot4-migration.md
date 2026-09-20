# Spring Boot 3.5 → 4.x migration (and support status)

Sources: Spring Boot 4.0 Migration Guide and 4.0/4.1 Release Notes (GitHub wiki), Spring Boot
system requirements, api.spring.io generations, Spring Security 7 migration docs,
Hibernate 7.0 migration guide, Jackson 3 migration guide. Checked 2026-09-18.

## Support status

| Line | OSS support until | Commercial until | Notes |
|---|---|---|---|
| 4.2 | (planned GA 2026-11-30) | — | next minor |
| **4.1.x** (4.1.1) | 2027-07-31 | 2028-07-31 | **target**: Framework 7.0.9, Security 7.1.1, Hibernate 7.4, Jackson 3.1, JUnit 6.0.3, Testcontainers 2.0.5, Mockito 5.23 |
| 4.0.x (4.0.8) | 2026-12-31 | 2027-12-31 | Security 7.0.x, Hibernate 7.2 |
| 3.5.x (3.5.16) | **ended 2026-06-30** | 2032-06-30 | only via paid support; plan the move now |
| ≤ 3.4 | ended | ended/ending | upgrade |

Spring Security 6.5 and Spring Framework 6.2 OSS support ended 2026-06-30 as well.
Requirements for 4.x: Java 17+ (tested up to 26, JDK 25 recommended), Jakarta EE 11 / Servlet 6.1
(Tomcat 11, Jetty 12.1 — Undertow is dropped), Kotlin 2.2+, GraalVM 25 for native images,
Maven 3.6.3+, Gradle 8.14+ or 9.x.

## Order of work

1. Upgrade to the latest **3.5.x** first and fix every deprecation warning (Boot, Security 6.5
   "prepare for 7" items, Hibernate 6.6 deprecations). Build green.
2. Add `spring-boot-properties-migrator` (runtime scope) temporarily; it reports and remaps renamed
   properties at startup. Remove it after the migration.
3. Optionally run OpenRewrite `org.openrewrite.java.spring.boot4.UpgradeSpringBoot_4_0`
   (artifact `org.openrewrite.recipe:rewrite-spring`), then review the diff.
4. Bump to 4.0/4.1, then work through the sections below until `./mvnw verify` / `./gradlew build` is green.
5. Full test suite + a smoke test of JSON contracts (Jackson 3 defaults) and security rules.

## Starters and modules

- Every technology is its own module (`spring-boot-<technology>`, root package
  `org.springframework.boot.<technology>`) with its own starter **and test starter**.
- `spring-boot-starter-web` → `spring-boot-starter-webmvc`; `spring-boot-starter-web-services` →
  `spring-boot-starter-webservices`; `spring-boot-starter-oauth2-*` →
  `spring-boot-starter-security-oauth2-*`. Old names still resolve but are deprecated.
- Test starters: `spring-boot-starter-webmvc-test`, `-data-jpa-test`, `-data-mongodb-test`,
  `-security-test`, `-restclient-test`, … (each pulls `spring-boot-starter-test`).
- Flyway/Liquibase need `spring-boot-starter-flyway` / `spring-boot-starter-liquibase`.
- Shortcut for large codebases: `spring-boot-starter-classic` + `spring-boot-starter-test-classic`
  bring the old monolithic auto-configuration back; migrate module by module afterwards.
- Package moves you will hit: `@EntityScan` → `org.springframework.boot.persistence.autoconfigure`;
  `@WebMvcTest`/`@AutoConfigureMockMvc` → `org.springframework.boot.webmvc.test.autoconfigure`;
  `@DataJpaTest` → `org.springframework.boot.data.jpa.test.autoconfigure`;
  `@DataMongoTest` → `org.springframework.boot.data.mongodb.test.autoconfigure`;
  `@AutoConfigureTestDatabase` → `org.springframework.boot.jdbc.test.autoconfigure`;
  `BootstrapRegistry` → `org.springframework.boot.bootstrap`; `EnvironmentPostProcessor` →
  `org.springframework.boot`.

## Jackson 3

- Group/package `com.fasterxml.jackson` → `tools.jackson` (annotations stay
  `com.fasterxml.jackson.annotation`). `ObjectMapper` is immutable → `JsonMapper.builder()`.
- Exceptions are unchecked (`JacksonException`, `DatabindException`, `StreamReadException`).
- Boot renames: `@JsonComponent` → `@JacksonComponent`, `@JsonMixin` → `@JacksonMixin`,
  `Jackson2ObjectMapperBuilderCustomizer` → `JsonMapperBuilderCustomizer`,
  `spring.jackson.read.*`/`write.*` → `spring.jackson.json.read.*`/`json.write.*` (4.1 re-adds generic
  `spring.jackson.read/write` for format-independent features).
- **Contract risk** — Jackson 3 defaults differ: `FAIL_ON_NULL_FOR_PRIMITIVES` on (null → `int` is now
  400), `READ/WRITE_ENUMS_USING_TO_STRING` on (enums with custom `toString()` change on the wire),
  `SORT_PROPERTIES_ALPHABETICALLY` on, `FAIL_ON_TRAILING_TOKENS` on. Either fix clients/tests or set
  `spring.jackson.use-jackson2-defaults=true` during the transition. Contract tests catch this.
- Jackson 2 stays usable temporarily via the deprecated `spring-boot-jackson2` module.

## Web

- Path matching: suffix pattern/trailing-slash matching options are gone (`/users/` ≠ `/users`).
- `RestTemplate` is in maintenance (deprecation planned for Framework 7.1) → `RestClient` or HTTP
  service interfaces (`@ImportHttpServices`).
- `HttpHeaders` no longer implements `MultiValueMap` — use its own accessor methods.
- New: API versioning (`spring.mvc.apiversion.*`), `@Retryable`/`@ConcurrencyLimit`
  (`@EnableResilientMethods`), `InetAddressFilter` for outbound SSRF protection (4.1), liveness and
  readiness probes enabled by default.
- Spring Retry is no longer version-managed — move to Framework 7 `@Retryable` or pin it yourself.

## Security 7 (details in `springboot-security`)

`and()` and `authorizeRequests()` removed → lambda DSL + `authorizeHttpRequests`;
`AntPathRequestMatcher`/`MvcRequestMatcher` removed → `PathPatternRequestMatcher` (string matchers
use it); `http.apply(...)` → `http.with(...)`; `AccessDecisionManager`/voters moved to
`spring-security-access`; OAuth2 password grant removed; OpenSAML 4 removed; Jackson 3
(`SecurityJacksonModules`).

## Data

- Hibernate 7 (Session API removals, `@Where` → `@SQLRestriction`, `hibernate-processor`) → `jpa-patterns`.
- MongoDB driver properties moved `spring.data.mongodb.*` → `spring.mongodb.*` (`uri`, `database`,
  `host`, `port`, `username`, `password`, `authentication-database`, `replica-set-name`, `ssl.*`,
  `representation.uuid`); Spring Data settings stay under `spring.data.mongodb.*`
  (`auto-index-creation`, `field-naming-strategy`, `gridfs.*`, `representation.big-decimal`).
  UUID/BigDecimal representations must be configured explicitly.
- Spring Batch no longer stores metadata in your database unless you use `spring-boot-starter-batch-jdbc`.
- Elasticsearch low-level `RestClient` auto-config replaced by `Rest5Client`.

## Testing

- `@MockBean`/`@SpyBean` removed → `@MockitoBean`/`@MockitoSpyBean`
  (`org.springframework.test.context.bean.override.mockito`).
- `@SpringBootTest` no longer auto-provides `MockMvc`, `WebTestClient`, `TestRestTemplate`: add
  `@AutoConfigureMockMvc`, `@AutoConfigureRestTestClient` or `@AutoConfigureTestRestTemplate`.
- JUnit 4 support (`SpringRunner`, rules) is deprecated; Testcontainers 2 dropped JUnit 4 entirely.
- Testcontainers 2 artifacts are prefixed (`testcontainers-postgresql`, `testcontainers-junit-jupiter`)
  and container classes moved (`org.testcontainers.postgresql.PostgreSQLContainer`, non-generic).
- 4.1: `-DskipTests` no longer skips AOT processing of tests — use `-Dmaven.test.skip=true` to skip both.

## Other

- JSpecify nullability everywhere; actuator endpoint parameters use `org.jspecify.annotations.Nullable`.
- Fully executable "launch script" jars removed; the `layertools` jar mode was removed in 4.1 → `tools`.
- DevTools LiveReload disabled by default (`spring.devtools.livereload.enabled=true`).
- Logback default charset UTF-8.
