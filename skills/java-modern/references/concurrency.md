# Concurrency: virtual threads, scoped values, structured concurrency

Sources: JEP 444 (virtual threads), JEP 491 (pinning fix, JDK 24), JEP 506 (scoped values, JDK 25),
JEP 505/525/533 (structured concurrency previews), Spring Boot reference "Virtual threads" and
"Task Execution and Scheduling".

## Virtual threads — the rules

1. **One virtual thread per task, never a pool.** `Executors.newVirtualThreadPerTaskExecutor()` or
   `Thread.ofVirtual().name("worker-", 0).start(task)`.
2. **They help blocking I/O, not CPU.** CPU-bound work still belongs on a bounded platform pool
   (`Executors.newFixedThreadPool(Runtime.getRuntime().availableProcessors())`) or `parallelStream`.
3. **Bound downstream concurrency explicitly.** With virtual threads nothing throttles you any more:
   10 000 concurrent requests will all hit the DB pool, the rate-limited API, the file system.

```java
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.Semaphore;
import java.util.concurrent.TimeUnit;

final class QuoteFanOut {
  private final Semaphore permits = new Semaphore(20);      // max 20 calls in flight to the supplier API
  private final QuoteClient client;

  QuoteFanOut(QuoteClient client) { this.client = client; }

  List<Quote> fetchAll(List<String> skus) throws Exception {
    try (ExecutorService executor = Executors.newVirtualThreadPerTaskExecutor()) {
      List<Future<Quote>> futures = skus.stream()
          .map(sku -> executor.submit(() -> fetchBounded(sku)))
          .toList();
      List<Quote> result = new ArrayList<>(futures.size());
      try {
        for (Future<Quote> f : futures) {
          result.add(f.get(5, TimeUnit.SECONDS));          // bounded wait per result
        }
      } catch (Exception e) {
        executor.shutdownNow();                            // interrupt the rest instead of waiting
        throw e;
      }
      return result;
    }                                                      // close() waits for submitted tasks
  }

  private Quote fetchBounded(String sku) throws InterruptedException {
    permits.acquire();
    try {
      return client.fetch(sku);                              // the client must have its own timeouts
    } finally {
      permits.release();
    }
  }
}
```

Simpler when order matters and the mapper throws only unchecked exceptions:
`skus.stream().gather(Gatherers.mapConcurrent(20, client::fetch)).toList()` (JDK 24+).

## Pinning by JDK version

| Situation | JDK 21–23 | JDK 24+ |
|---|---|---|
| blocking inside `synchronized` | pins the carrier → throughput collapse under load | fixed (JEP 491) |
| `Object.wait()` in `synchronized` | pins | fixed |
| blocking inside a native frame / JNI callback | pins | still pins |
| blocking in a class initializer / waiting for class init | pins | still pins (rare) |

- On 21–23 replace `synchronized` around I/O with `java.util.concurrent.locks.ReentrantLock`.
- `-Djdk.tracePinnedThreads` was removed with JEP 491; use JFR event `jdk.VirtualThreadPinned`
  (native pinning on 24+) and thread dumps.

## Diagnostics

```bash
jcmd <pid> Thread.dump_to_file -format=json threads.json      # includes virtual threads
jcmd <pid> JFR.start duration=60s filename=vt.jfr
jfr print --events jdk.VirtualThreadPinned,jdk.VirtualThreadSubmitFailed vt.jfr
```

## Scoped values instead of ThreadLocal

```java
public final class RequestContext {
  public static final ScopedValue<String> TENANT = ScopedValue.newInstance();
  private RequestContext() {}
}

// at the edge (filter, message listener):
ScopedValue.where(RequestContext.TENANT, tenantId).run(() -> handler.handle(request));

// anywhere below, on the same thread:
String tenant = RequestContext.TENANT.orElseThrow(() -> new IllegalStateException("no tenant bound"));
```

- Immutable binding with a bounded lifetime — no `remove()` leaks, no stale value when a pooled
  platform thread is reused. `orElse(null)` is rejected in the final API.
- Values are **not** inherited by threads you start yourself, except by child tasks of a
  `StructuredTaskScope`.
- Existing ThreadLocal-based frameworks (Spring Security `SecurityContextHolder`, MDC, transaction
  synchronisation) keep working per virtual thread. When handing work to another executor, propagate
  explicitly: `DelegatingSecurityContextExecutorService`, a `TaskDecorator` copying the MDC, or
  Micrometer context propagation.

## Structured concurrency (preview — do not ship)

JDK 25 shape (5th preview); needs `--enable-preview`:

```java
Response handle() throws InterruptedException {
  try (var scope = StructuredTaskScope.open()) {        // default: fail fast if any subtask fails
    Subtask<User> user = scope.fork(() -> findUser());
    Subtask<Order> order = scope.fork(() -> fetchOrder());
    scope.join();                                      // waits, propagates the first failure
    return new Response(user.get(), order.get());
  }                                                    // leaving the block cancels stragglers
}
```

API churn: JDK 26 (6th preview) and JDK 27 (7th preview: `join()` throws `ExecutionException`,
an extra exception type parameter, `timeout()` replaces `onTimeout()`, `awaitAll()` removed) — code
written against one preview does not compile on the next. Production alternative today: a
virtual-thread executor with futures and timeouts (above), or `Gatherers.mapConcurrent`.

## CompletableFuture hygiene

- Always pass an executor: `supplyAsync(task, executor)` — the default common pool is sized for CPU.
- Always bound time: `orTimeout(3, TimeUnit.SECONDS)` or `completeOnTimeout(fallback, ...)`.
- Terminal `exceptionally`/`handle`, never a silently dropped future (pair with `silent-failure-hunter`).
- With virtual threads, plain blocking code in a VT is usually clearer than long `thenCompose` chains.

## Spring Boot

```properties
# Tomcat/Jetty request threads, @Async, @Scheduled, listeners
spring.threads.virtual.enabled=true
# virtual threads are daemon threads
spring.main.keep-alive=true
# optional cap for @Async on virtual threads
spring.task.execution.simple.concurrency-limit=200
```

- With virtual threads on, `spring.task.execution.pool.*` / `spring.task.scheduling.pool.*` have no
  effect; `SimpleAsyncTaskExecutor`/`SimpleAsyncTaskScheduler` are used.
- HikariCP `maximum-pool-size` becomes the real concurrency limit for DB work; keep
  `connection-timeout` short (e.g. 2–5 s) so overload fails fast instead of queueing forever.
- Prefer Spring MVC + virtual threads for new blocking-style services; choose WebFlux only for
  streaming/back-pressure needs or an already reactive stack.

## Anti-patterns to flag

- A fixed pool of virtual threads, or `newVirtualThreadPerTaskExecutor()` stored in a field and never closed.
- Virtual threads used for CPU-heavy work (image processing, hashing loops) — no gain, more scheduling.
- `ThreadLocal<ExpensiveObject>` caches (formatters, buffers) on virtual threads — memory blow-up.
- `synchronized` around network or DB calls on JDK 21–23.
- Unbounded fan-out to a downstream service (no `Semaphore`/limit) — self-inflicted DoS.
- `parallelStream()` for I/O — it runs on the common ForkJoinPool sized for CPU.
- Mutable non-final fields in singleton beans without synchronisation (race conditions regardless of thread type).
