# JVM performance: flags, GC, startup, profiling, code hot spots

Measure first (`backend-performance` has the baseline → change → measure loop and load-test tools).
Sources: JEP 514/515 (AOT cache), JEP 519/534 (compact headers), JEP 520 (JFR method timing),
JEP 523 (G1 default in 27), Spring Boot "AOT Cache" reference, HikariCP "About Pool Sizing".

## Container baseline (JDK 21/25)

```bash
java \
  -XX:MaxRAMPercentage=75 \
  -XX:+UseG1GC \
  -XX:+ExitOnOutOfMemoryError \
  -XX:+HeapDumpOnOutOfMemoryError -XX:HeapDumpPath=/dumps \
  -Xlog:gc*:file=/logs/gc.log:time,uptime:filecount=5,filesize=20m \
  -jar app.jar
```

- `MaxRAMPercentage=75`: the default is 25 % of the container limit.
- `UseG1GC` explicitly: JDK ≤ 26 silently picks Serial with 1 CPU or < 1792 MB.
- `ExitOnOutOfMemoryError`: let the orchestrator restart a broken JVM instead of limping on.

- Leave 20–25 % of the container memory for metaspace, thread stacks, code cache, direct buffers
  (Netty), and native allocations (sharp-like image libs via JNI, compression).
- CPU quota < 1 core makes the JVM size pools (GC threads, `ForkJoinPool.commonPool`, Netty event
  loops) for one CPU. Override only with evidence: `-XX:ActiveProcessorCount=2`.
- Native memory leaks (RSS grows, heap does not): `-XX:NativeMemoryTracking=summary`, then
  `jcmd <pid> VM.native_memory summary` (diff against a baseline with `summary.diff`).

## GC choice

| Collector | Flag | Use for | Notes |
|---|---|---|---|
| G1 | `-XX:+UseG1GC` | default for services | JDK 27 always selects it (JEP 523); tune `-XX:MaxGCPauseMillis` only with GC logs |
| ZGC | `-XX:+UseZGC` | large heaps, p99 pause budgets < 1–2 ms | generational only since JDK 24 (JEP 490); needs heap headroom |
| Parallel | `-XX:+UseParallelGC` | batch jobs, throughput over latency | long pauses on big heaps |
| Shenandoah | `-XX:+UseShenandoahGC` | low pause alternative to ZGC | in Temurin/Corretto builds, not Oracle JDK; generational mode is product in 25 |
| Serial | `-XX:+UseSerialGC` | tiny CLIs, < 512 MB | never for multi-core services |

## Startup and footprint

- **AOT cache (JDK 25, JEP 514/515)** — one training run, then reuse:

  ```bash
  java -Djarmode=tools -jar app.jar extract --destination application   # Spring Boot: extract first
  cd application
  java -XX:AOTCacheOutput=app.aot -Dspring.context.exit=onRefresh -jar app.jar   # training run
  java -XX:AOTCache=app.aot -jar app.jar                                        # production
  ```

  The cache is only valid for the same JDK build and the same class path (rebuild it in the image
  build, never copy it between versions). JDK 24 used the two-step `-XX:AOTMode=record/create`.
  JDK ≤ 24 with Spring Boot: CDS via `-XX:ArchiveClassesAtExit=application.jsa` /
  `-XX:SharedArchiveFile=application.jsa`.
- **Compact object headers**: `-XX:+UseCompactObjectHeaders` (product in 25, default in 27, disable
  with `-XX:-UseCompactObjectHeaders`). JEP 534 measured 22 % less heap and 8 % less CPU on
  SPECjbb2015 — verify with your own load test.
- **GraalVM native image**: fastest start, lowest RSS, slower peak throughput and longer builds;
  Spring Boot 4 requires GraalVM 25. Worth it for scale-to-zero functions and CLIs, rarely for
  long-running services.

## Profiling recipes

```bash
# Always-on low-overhead recording, dump on demand
java -XX:StartFlightRecording=disk=true,maxage=6h,settings=default,filename=/logs/app.jfr -jar app.jar
jcmd <pid> JFR.dump filename=/tmp/now.jfr

# Read it without a GUI (JDK 21+)
jfr view hot-methods /tmp/now.jfr
jfr view gc-pauses /tmp/now.jfr
jfr view allocation-by-class /tmp/now.jfr
jfr summary /tmp/now.jfr

# JDK 25 method timing / tracing (JEP 520) — no agent, no code change
java '-XX:StartFlightRecording:method-timing=com.example.OrderService::place,filename=t.jfr' -jar app.jar
jfr view method-timing t.jfr

# Threads (virtual threads included) and heap
jcmd <pid> Thread.dump_to_file -format=json /tmp/threads.json
jcmd <pid> GC.heap_info
jcmd <pid> GC.class_histogram | head -30
```

- JDK Mission Control or IntelliJ open `.jfr` files; async-profiler adds flame graphs incl. native
  frames (`asprof -d 30 -e cpu -f cpu.html <pid>`; `-e alloc`, `-e lock`, `-e wall`).
- Micro-benchmarks only with JMH (`org.openjdk.jmh`), `@Fork(≥1)`, warm-up iterations, results fed to
  `Blackhole`; never `System.nanoTime()` loops.

## Code-level hot spots (review checklist)

| Smell | Fix |
|---|---|
| N+1 queries, unbounded `findAll()` | fetch joins / projections / pagination (`jpa-patterns`) |
| Missing timeouts on HTTP/DB/cache clients | connect + read timeouts everywhere; fail fast beats queueing |
| New `HttpClient`/`RestClient`/`ObjectMapper`/`JsonMapper` per call | one shared, thread-safe instance |
| `Pattern.compile` / `String.matches` / `replaceAll` in hot paths | precompiled `static final Pattern` |
| Exceptions for control flow, `e.printStackTrace()` | return values / `Optional`; log once at the boundary |
| `log.debug("x " + expensive())` | `log.debug("x {}", value)` or `log.atDebug().addArgument(() -> ...)` |
| Boxed types in hot loops (`List<Integer>` sums, `Map<Long, …>` keys) | primitive streams/arrays; Eclipse Collections/fastutil only after profiling |
| `synchronized` around I/O on JDK 21–23 with virtual threads | `ReentrantLock` or JDK 24+ |
| Unbounded `ConcurrentHashMap` caches | Caffeine with `maximumSize` + `expireAfterWrite` |
| Large `byte[]`/`String` building of responses | streaming (`StreamingResponseBody`, `InputStream.transferTo`) |
| `parallelStream()` for I/O or inside request threads | virtual threads with a bound, or `Gatherers.mapConcurrent` |
| `BigDecimal` via `new BigDecimal(double)` | `BigDecimal.valueOf(double)` or string constructor (correctness too) |

## Pools

- DB pool size is a concurrency limit, not a throughput dial: start near
  `(2 × CPU cores of the DB) + effective spindles` (HikariCP wiki), measure, and keep
  `connection-timeout` short (2–5 s) so saturation is visible instead of hidden in latency.
- One JDK `HttpClient` per downstream (it pools connections internally); set
  `connectTimeout` on the builder and `timeout(...)` on every `HttpRequest`.
