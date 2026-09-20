---
name: jpa-patterns
description: "JPA with Hibernate 7 / Jakarta Persistence 3.2 and Spring Data JPA: entities, relationships, N+1 fixes, fetch plans, projections, transactions, batching, locking, pagination, HikariCP, safe queries. Use when designing entities or fixing slow or wrong JPA queries and transactions."
metadata:
  origin: ECC
---

# JPA / Hibernate Patterns

Data modelling, repositories and performance for relational databases in Spring Boot.
Spring Boot 4.1 manages Hibernate ORM 7.4, Jakarta Persistence 3.2, Spring Data JPA 4.1 and
HikariCP 7.0 (Boot 4.0: Hibernate 7.2). Boot 3.5 (Hibernate 6.6) left OSS support on 2026-06-30.
MongoDB with Spring Data is not JPA — see the MongoDB notes in `java-reviewer` and
`java-modern/references/secure-coding.md`.

## When to Activate

- Designing entities, IDs, relationships, embeddables
- A page or job issues too many queries (N+1) or loads too much
- Transactions behave unexpectedly (no rollback, lazy-loading errors, lost updates)
- Upgrading Hibernate 6 → 7 / Spring Boot 3.5 → 4
- Tuning batching, pagination or the connection pool

## Entity Design

```java
@Entity
@Table(name = "orders", indexes = @Index(name = "idx_orders_customer_created", columnList = "customer_id, created_at"))
@EntityListeners(AuditingEntityListener.class)
public class OrderEntity {

  @Id
  @GeneratedValue(strategy = GenerationType.SEQUENCE, generator = "orders_seq")
  @SequenceGenerator(name = "orders_seq", sequenceName = "orders_seq", allocationSize = 50)
  private Long id;

  @Version
  private long version;                                  // optimistic locking

  @ManyToOne(fetch = FetchType.LAZY, optional = false)   // *ToOne is EAGER by default — always set LAZY
  @JoinColumn(name = "customer_id")
  private CustomerEntity customer;

  @OneToMany(mappedBy = "order", cascade = CascadeType.ALL, orphanRemoval = true)
  private Set<OrderLineEntity> lines = new HashSet<>();

  @Enumerated(EnumType.STRING)
  @Column(nullable = false, length = 20)
  private OrderStatus status = OrderStatus.NEW;

  @Embedded
  private Money total;                                   // JPA 3.2: records may be embeddables

  @CreatedDate private Instant createdAt;
  @LastModifiedDate private Instant updatedAt;

  protected OrderEntity() {}                             // for JPA only

  public void addLine(OrderLineEntity line) {            // keep both sides of the association in sync
    lines.add(line);
    line.setOrder(this);
  }

  @Override public boolean equals(Object o) {
    return this == o || (o instanceof OrderEntity other && id != null && id.equals(other.id));
  }
  @Override public int hashCode() { return getClass().hashCode(); }   // stable across persist
}

@Embeddable
public record Money(BigDecimal amount, String currency) {}
```

- `SEQUENCE` with `allocationSize` > 1 keeps JDBC insert batching; `IDENTITY` disables it.
- Never Lombok `@Data`/`@EqualsAndHashCode`/`@ToString` on entities (lazy loading in `toString`,
  broken hash sets). Getters/setters or explicit methods only.
- Entities never leave the service layer — map to DTO records for the API.
- `Instant`/`LocalDate` only (JPA 3.2 deprecates `Date`/`Calendar`); money as `BigDecimal` with explicit scale.
- Enable auditing with `@EnableJpaAuditing` on a `@Configuration` class.

## Relationships and N+1

| Problem | Fix |
|---|---|
| Loop over parents touches `parent.getChildren()` | fetch plan: `@EntityGraph(attributePaths = "lines")` or `join fetch` |
| Many parents, one lazy collection each | `spring.jpa.properties.hibernate.default_batch_fetch_size=50` (IN-batches) |
| Two `List` collections join-fetched | `MultipleBagFetchException` → use `Set`, or two queries |
| `join fetch` + pagination | Hibernate paginates in memory (warning HHH90003004): page IDs first, then fetch by IDs |
| Read-only list screens | DTO projection — no entities, no dirty checking |
| `@ManyToMany` with extra columns | explicit join entity |

```java
public interface OrderRepository extends JpaRepository<OrderEntity, Long> {

  @EntityGraph(attributePaths = {"customer", "lines"})
  Optional<OrderEntity> findWithDetailsById(Long id);

  @Query("select o.id from OrderEntity o where o.status = :status")
  Page<Long> findIdsByStatus(@Param("status") OrderStatus status, Pageable pageable);

  @Query("select distinct o from OrderEntity o left join fetch o.lines where o.id in :ids")
  List<OrderEntity> findWithLinesByIdIn(@Param("ids") Collection<Long> ids);

  // DTO projection straight from JPQL
  @Query("""
      select new com.example.order.OrderSummary(o.id, c.name, o.status, o.createdAt)
      from OrderEntity o join o.customer c
      where c.id = :customerId
      """)
  List<OrderSummary> findSummaries(@Param("customerId") Long customerId);
}

public record OrderSummary(Long id, String customerName, OrderStatus status, Instant createdAt) {}
```

Make N+1 visible in tests: `spring.jpa.properties.hibernate.generate_statistics=true` and assert
`Statistics#getPrepareStatementCount()`, or wrap the `DataSource` with datasource-proxy.
Set `spring.jpa.properties.hibernate.query.fail_on_pagination_over_collection_fetch=true` so in-memory
pagination fails instead of warning.

## Transactions

```java
@Service
public class OrderService {

  @Transactional(readOnly = true)                   // no dirty checking/flush; read replicas can route on it
  public OrderView get(Long id) { ... }

  @Transactional                                    // write: short, no remote calls inside
  public void cancel(Long id) {
    OrderEntity order = repo.findById(id).orElseThrow(() -> new OrderNotFoundException(id));
    order.cancel();                                 // dirty checking flushes at commit, no save() needed
  }
}
```

- `@Transactional` works through the proxy: calls from the same class (`this.cancel()`), `private`
  methods and `final` classes/methods are **not** transactional.
- Checked exceptions do not roll back by default → `@Transactional(rollbackFor = Exception.class)` or
  throw unchecked.
- No HTTP calls, emails or message publishing inside a DB transaction; publish after commit
  (`@TransactionalEventListener(phase = AFTER_COMMIT)` or an outbox table).
- `spring.jpa.open-in-view=false` — the default `true` keeps a connection for the whole request and
  hides lazy-loading bugs until production load.

## Batching and Bulk Work

```properties
spring.jpa.properties.hibernate.jdbc.batch_size=50
spring.jpa.properties.hibernate.order_inserts=true
spring.jpa.properties.hibernate.order_updates=true
```

- Large imports: chunk (`saveAll` per 500–1000, then `entityManager.flush(); entityManager.clear();`)
  or a `StatelessSession` — in Hibernate 7 it no longer batches by default, call
  `statelessSession.setJdbcBatchSize(50)`.
- Bulk updates: `@Modifying(clearAutomatically = true) @Query("update … where …")` inside a
  transaction; they bypass `@Version`, lifecycle callbacks and the persistence context.

## Locking

- Optimistic (`@Version`) by default; handle `ObjectOptimisticLockingFailureException` as HTTP 409 and
  let the client retry with fresh data.
- Pessimistic only for short critical sections:
  `@Lock(LockModeType.PESSIMISTIC_WRITE)` + `@QueryHints(@QueryHint(name = "jakarta.persistence.lock.timeout", value = "3000"))`.

## Pagination

- Cap page size (`spring.data.web.pageable.max-page-size=100`) — unbounded lists are a DoS.
- `Page` runs a count query; `Slice` skips it (infinite scroll).
- Deep pages: keyset scrolling instead of `OFFSET`:

```java
Window<OrderEntity> findFirst50ByStatusOrderByIdAsc(OrderStatus status, ScrollPosition position);
// first call: ScrollPosition.keyset(); next: window.positionAt(window.size() - 1)
```

## Query Safety

- Named parameters only (`:name`); never concatenate into JPQL, native SQL or `Sort`.
- User-controlled sorting: map to an allowlist of properties; never `JpaSort.unsafe(input)`.
  CVE-2026-47834 (Sort validation bypass for `@NativeQuery` / `nativeQuery = true`) is fixed in
  Spring Data JPA 4.1.1 / 4.0.7 — Spring Boot 4.1.1 manages 4.1.1.
- Native queries with `LIKE`: escape `%`/`_` in user input or use `like :pattern escape '\'`.

## Hibernate 6.6 → 7 Checklist

| Removed / changed | Replacement |
|---|---|
| `Session#load`, `save`, `update`, `saveOrUpdate`, `delete` | `getReference`, `persist`, `merge`, `remove` |
| `CascadeType.SAVE_UPDATE`, `DELETE` (Hibernate enum) | JPA `PERSIST`/`MERGE`/`REMOVE` |
| `@Where`, `@WhereJoinTable`, `@Proxy`, `@LazyToOne`, `@LazyCollection`, `@Loader` | `@SQLRestriction`, `@SQLJoinTableRestriction`, defaults / `@EntityGraph` |
| `hibernate-jpamodelgen` | `org.hibernate.orm:hibernate-processor` (declare as annotation processor) |
| refreshing detached entities | not allowed; `hibernate.allow_refresh_detached_entity` removed |
| licence LGPL | Apache 2.0 |

Also: Java 17 baseline; ambiguous HQL without `select` is rejected; Spring Boot 4 moved
`@EntityScan` to `org.springframework.boot.persistence.autoconfigure`.

Useful Jakarta Persistence 3.2 additions: `getSingleResultOrNull()`, JPQL `union`/`intersect`/`except`
and `||`, `Instant`/`Year` attributes, `@EnumeratedValue` on an enum field for stable DB codes,
`EntityManagerFactory#runInTransaction`/`callInTransaction` outside Spring.

## Connection Pool (HikariCP)

```properties
# start ~ (2 x DB cores) + spindles, then measure
spring.datasource.hikari.maximum-pool-size=20
# fixed-size pool avoids connection churn
spring.datasource.hikari.minimum-idle=20
# ms; default 30000 hides saturation as latency
spring.datasource.hikari.connection-timeout=3000
# below any DB/proxy idle cutoff
spring.datasource.hikari.max-lifetime=1500000
# dev/staging: log connections held > 20 s
spring.datasource.hikari.leak-detection-threshold=20000
# Boot 4.1: connection only when first statement runs
spring.datasource.connection-fetch=lazy
```

With virtual threads the pool size **is** the DB concurrency limit — do not raise it to match request
concurrency.

## Migrations and Schema

- Flyway or Liquibase; Spring Boot 4 needs `spring-boot-starter-flyway` / `spring-boot-starter-liquibase`.
- Production: `spring.jpa.hibernate.ddl-auto=validate` (or `none`); never `update`/`create`.
- Additive, backward-compatible steps (expand → migrate → contract) for zero-downtime deploys.

## Caching

- The persistence context is per transaction; never keep entities across transactions or in caches.
- Second-level cache only for read-mostly reference data with a clear eviction story; cache DTOs at
  the service level (`@Cacheable`) instead of entities.

## Testing Data Access

- `@DataJpaTest` (`org.springframework.boot.data.jpa.test.autoconfigure.DataJpaTest`, starter
  `spring-boot-starter-data-jpa-test`) against the real database via Testcontainers and
  `@ServiceConnection` — see `springboot-tdd`. H2 hides dialect, locking and constraint differences.
- SQL visibility while debugging: `logging.level.org.hibernate.SQL=debug`,
  `logging.level.org.hibernate.orm.jdbc.bind=trace` (never in production — binds contain personal data).

**Remember**: lazy by default, explicit fetch plans per use case, DTOs for reads, short transactions,
and measure query counts, not just response times.
