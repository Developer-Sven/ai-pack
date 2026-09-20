---
name: springboot-tdd
description: "Test-first Spring Boot 4: JUnit 6, AssertJ, Mockito 5 agent setup, @MockitoBean, slices (@WebMvcTest, @DataJpaTest, @DataMongoTest), MockMvcTester, RestTestClient, Testcontainers 2 with @ServiceConnection, JaCoCo gates. Use when adding features, fixing bugs or writing Spring tests."
metadata:
  origin: ECC
---

# Spring Boot TDD Workflow

Red → green → refactor for Spring Boot 4.x services. Versions managed by Boot 4.1.1: JUnit 6.0.3
(latest 6.1.3), Mockito 5.23, AssertJ 3.27, Testcontainers 2.0.5, Awaitility 4.3. JaCoCo 0.8.14+
for JDK 25 (0.8.15 for 26).

## When to Use

- New features or endpoints (write the failing test first)
- Bug fixes: reproduce with a failing test (RED), fix (GREEN), keep the test
- Refactors: characterization tests first, behaviour unchanged afterwards
- Data access, security rules, external clients

## Workflow

1. Write the smallest test that expresses the next behaviour; run it and watch it fail for the
   right reason.
2. Implement the minimum to pass; run the whole affected test class.
3. Refactor with tests green; run `./mvnw verify` / `./gradlew check` before committing.
4. Coverage is a floor (JaCoCo check), not the goal — every branch that carries a business rule
   or a permission decision has a test, including the **denied** path.

## Which Test Type

| Goal | Annotation | Starter (Boot 4) | Speed |
|---|---|---|---|
| Domain/service logic | none, `@ExtendWith(MockitoExtension.class)` | `spring-boot-starter-test` | ms |
| Controller: mapping, validation, status, JSON, security rules | `@WebMvcTest(XController.class)` | `spring-boot-starter-webmvc-test` | ~1 s |
| Repository/queries against a real DB | `@DataJpaTest` / `@DataMongoTest` + Testcontainers | `spring-boot-starter-data-jpa-test` / `-data-mongodb-test` | seconds |
| Outbound HTTP client | `@RestClientTest` + `MockRestServiceServer` | `spring-boot-starter-restclient-test` | ~1 s |
| Full stack through HTTP | `@SpringBootTest(webEnvironment = RANDOM_PORT)` + Testcontainers | above + `spring-boot-testcontainers` | slowest |

Boot 4 moved slice annotations into technology modules — imports:
`org.springframework.boot.webmvc.test.autoconfigure.WebMvcTest`,
`org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc`,
`org.springframework.boot.data.jpa.test.autoconfigure.DataJpaTest`,
`org.springframework.boot.data.mongodb.test.autoconfigure.DataMongoTest`,
`org.springframework.boot.jdbc.test.autoconfigure.AutoConfigureTestDatabase`,
`org.springframework.boot.restclient.test.autoconfigure.RestClientTest`,
`org.springframework.test.context.bean.override.mockito.MockitoBean`.

## Mockito Agent (JDK 21+)

Mockito's inline mock maker self-attaches an agent, which the JDK warns about (JEP 451) and will block.
Load it explicitly (the Boot parent does not do this for you):

```xml
<plugin>
  <artifactId>maven-dependency-plugin</artifactId>
  <executions><execution><goals><goal>properties</goal></goals></execution></executions>
</plugin>
<plugin>
  <artifactId>maven-surefire-plugin</artifactId>
  <configuration><argLine>@{argLine} -javaagent:${org.mockito:mockito-core:jar}</argLine></configuration>
</plugin>
```

`@{argLine}` must resolve: JaCoCo's `prepare-agent` sets it, otherwise declare an empty `<argLine/>`
property. Gradle version: `java-modern/references/build-tooling.md`.

## Unit Tests (JUnit 6 + Mockito + AssertJ)

```java
@ExtendWith(MockitoExtension.class)                 // strict stubs: unused stubbing fails the test
class OrderServiceTest {
  @Mock OrderRepository repo;
  @Mock PaymentGateway payments;
  Clock clock = Clock.fixed(Instant.parse("2026-09-18T10:00:00Z"), ZoneOffset.UTC);
  OrderService service;

  @BeforeEach void setUp() { service = new OrderService(repo, payments, clock); }

  @Test
  void placeOrder_rejectsEmptyCart() {
    assertThatThrownBy(() -> service.place(new PlaceOrder("c-1", List.of())))
        .isInstanceOf(InvalidOrderException.class)
        .hasMessageContaining("empty");
    verifyNoInteractions(payments);
  }

  @Test
  void placeOrder_chargesTotalOnce() {
    when(repo.save(any())).thenAnswer(inv -> inv.getArgument(0));

    Order order = service.place(new PlaceOrder("c-1", List.of(new Line("sku-1", 2))));

    ArgumentCaptor<ChargeRequest> charge = ArgumentCaptor.forClass(ChargeRequest.class);
    verify(payments).charge(charge.capture());
    assertThat(charge.getValue().amount()).isEqualByComparingTo("19.98");
    assertThat(order.createdAt()).isEqualTo(clock.instant());
  }

  @ParameterizedTest
  @CsvSource({ "0, false", "1, true", "1000, true", "1001, false" })
  void quantityBounds(int quantity, boolean valid) {
    assertThat(Line.isValidQuantity(quantity)).isEqualTo(valid);
  }
}
```

- Construct the class under test yourself; `@InjectMocks` hides constructor changes.
- Mock only collaborators you own at the boundary (repositories, gateways); never mock value objects
  or the class under test (no partial mocks without a strong reason).
- Inject `Clock`/ID generators for determinism; no `Thread.sleep` — use Awaitility for async results.

## Web Slice (MockMvcTester)

```java
@WebMvcTest(OrderController.class)
class OrderControllerTest {
  @Autowired MockMvcTester mvc;                      // AssertJ-based, Framework 6.2+
  @MockitoBean OrderService orders;                  // @MockBean was removed in Boot 4

  @Test
  @WithMockUser
  void create_returns201WithLocation() {
    when(orders.create(any())).thenReturn(new Order(42L, "c-1", OrderStatus.NEW, new BigDecimal("19.98")));

    assertThat(mvc.post().uri("/api/orders").with(csrf())
            .contentType(MediaType.APPLICATION_JSON)
            .content("""
                {"customerRef":"c-1","lines":[{"sku":"sku-1","quantity":2}]}
                """))
        .hasStatus(HttpStatus.CREATED)
        .hasHeader(HttpHeaders.LOCATION, "http://localhost/api/orders/42")
        .bodyJson().extractingPath("$.id").isEqualTo(42);
  }

  @Test
  @WithMockUser
  void create_rejectsInvalidBody() {
    assertThat(mvc.post().uri("/api/orders").with(csrf())
            .contentType(MediaType.APPLICATION_JSON).content("{\"lines\":[]}"))
        .hasStatus(HttpStatus.BAD_REQUEST);
    verifyNoInteractions(orders);
  }
}
```

`@WebMvcTest` loads the security configuration: test anonymous (401), wrong role (403) and foreign
resource (404) cases here (`springboot-security` has a JWT example). Classic `MockMvc` +
`jsonPath` still works; prefer `MockMvcTester` in new tests.

## Testcontainers 2 with @ServiceConnection

```java
@TestConfiguration(proxyBeanMethods = false)
public class TestcontainersConfig {                     // one config per store keeps slice tests lean

  @Bean
  @ServiceConnection                                   // sets spring.datasource.* automatically
  PostgreSQLContainer postgres() {                      // org.testcontainers.postgresql.PostgreSQLContainer (2.x, not generic)
    return new PostgreSQLContainer("postgres:18-alpine");
  }

  @Bean
  @ServiceConnection
  MongoDBContainer mongo() {                            // org.testcontainers.mongodb.MongoDBContainer
    return new MongoDBContainer("mongo:8.0");
  }
}
```

```xml
<dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-testcontainers</artifactId><scope>test</scope></dependency>
<dependency><groupId>org.testcontainers</groupId><artifactId>testcontainers-junit-jupiter</artifactId><scope>test</scope></dependency>
<dependency><groupId>org.testcontainers</groupId><artifactId>testcontainers-postgresql</artifactId><scope>test</scope></dependency>
<dependency><groupId>org.testcontainers</groupId><artifactId>testcontainers-mongodb</artifactId><scope>test</scope></dependency>
```

- Testcontainers 2 renamed every module (`postgresql` → `testcontainers-postgresql`,
  `junit-jupiter` → `testcontainers-junit-jupiter`), moved container classes to
  `org.testcontainers.<module>` and removed JUnit 4 support.
- Prefer `@ServiceConnection` over `@DynamicPropertySource`; keep `@DynamicPropertySource` for
  properties that have no connection-details support.
- Pin image tags to the production major version; never `latest`.
- Same containers for local runs: `SpringApplication.from(ShopApplication::main).with(TestcontainersConfig.class).run(args)`
  in a `src/test/java` main class.

## Repository Tests

```java
@DataJpaTest                                   // default Replace.NON_TEST keeps @ServiceConnection databases
@Import(TestcontainersConfig.class)
class OrderRepositoryTest {
  @Autowired OrderRepository repo;
  @Autowired TestEntityManager em;

  @Test
  void findByIdAndOwnerId_hidesForeignOrders() {
    OrderEntity order = em.persistFlushFind(OrderEntity.newFor("owner-a"));
    assertThat(repo.findByIdAndOwnerId(order.getId(), "owner-b")).isEmpty();
    assertThat(repo.findByIdAndOwnerId(order.getId(), "owner-a")).isPresent();
  }
}
```

Only a DataSource configured by hand (no `@ServiceConnection`, `@DynamicPropertySource` or
Testcontainers JDBC URL) needs `@AutoConfigureTestDatabase(replace = Replace.NONE)`.
`@DataJpaTest` is transactional and rolls back after each test; flush (`persistFlushFind`,
`em.flush()`) so constraint violations and SQL actually happen. H2 instead of the real database hides
dialect, locking and constraint behaviour.

## Full-Stack Tests (RestTestClient)

```java
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@AutoConfigureRestTestClient                    // Boot 4: no longer implicit in @SpringBootTest
@Import(TestcontainersConfig.class)
class OrderFlowIT {
  @Autowired RestTestClient client;             // org.springframework.test.web.servlet.client.RestTestClient

  @Test
  void healthIsUp() {
    client.get().uri("/actuator/health").exchange().expectStatus().isOk();
  }
}
```

Name integration tests `*IT` and run them with Failsafe (`./mvnw verify`) or a Gradle test suite so
the unit loop stays fast. Context caching: identical configuration across tests reuses the context —
avoid per-class `@MockitoBean` sprawl and `@DirtiesContext` in integration tests.

## JUnit 6 Notes

- Java 17 baseline; one version number for Platform, Jupiter and Vintage; JSpecify annotations.
- Gradle 9 needs `testRuntimeOnly("org.junit.platform:junit-platform-launcher")`.
- `@CsvSource`/`@CsvFileSource` now parse with FastCSV: stricter quoting, `lineSeparator` removed.
- Removed: `MethodOrderer.Alphanumeric` (use `MethodName`), `junit-platform-runner`; Vintage (JUnit 4)
  is deprecated — migrate remaining JUnit 4 tests, Testcontainers 2 and Spring 7 no longer support them.

## Coverage and Quality Gates

- JaCoCo `check` with line ≥ 80 %, branch ≥ 70 % (snippet in `java-modern/references/build-tooling.md`);
  exclude generated code and `*Application` classes, never business logic.
- Optional: mutation testing with PIT (`org.pitest:pitest-maven` 1.30.x) on core domain packages;
  ArchUnit rules for layering.

## CI Commands

```bash
./mvnw -B -ntp verify                 # unit (Surefire) + integration (Failsafe) + JaCoCo check
./gradlew check                       # test + jacocoTestReport/verification tasks
./mvnw -Dtest=OrderServiceTest test   # single class while iterating
```

**Remember**: fast, isolated, deterministic tests that assert behaviour at the boundary — including
what must be denied.
