# Java language and platform features by release (17 → 27)

Final features only unless marked *(preview)* / *(incubator)*. Source: the OpenJDK project page of each
release (https://openjdk.org/projects/jdk/NN/). Preview features need `--enable-preview` at compile
and run time and must not ship in production artifacts.

## Release map

| JDK | Final features worth knowing | Still preview / incubator |
|---|---|---|
| 17 LTS | sealed classes (409), strong encapsulation of JDK internals (403), context-specific deserialization filters (415), enhanced PRNGs (356); records (395) and `instanceof` patterns (394) from 16 | — |
| 18 | UTF-8 by default (400), `jwebserver` (408), `@snippet` in Javadoc (413), finalization deprecated for removal (421) | — |
| 21 LTS | **virtual threads (444)**, **record patterns (440)**, **pattern matching for switch (441)**, **sequenced collections (431)**, generational ZGC (439), KEM API (452), warnings for dynamic agent loading (451) | string templates (later withdrawn), scoped values, structured concurrency |
| 22 | **unnamed variables & patterns `_` (456)**, **Foreign Function & Memory API (454)**, multi-file source launch (458), region pinning for G1 (423) | statements before `super`, gatherers, class-file API |
| 23 | Markdown doc comments `///` (467), ZGC generational by default (474), `sun.misc.Unsafe` memory access deprecated for removal (471) | module imports, primitive patterns |
| 24 | **stream gatherers (485)**, class-file API (484), **`synchronized` without pinning virtual threads (491)**, AOT class loading & linking (483), Security Manager permanently disabled (486), ML-KEM (496), ML-DSA (497), JNI restriction warnings (472), `Unsafe` memory-access warnings (498), ZGC non-generational mode removed (490) | — |
| 25 LTS | **scoped values (506)**, **module import declarations (511)**, **compact source files & instance main (512)**, **flexible constructor bodies (513)**, AOT command-line ergonomics (514), AOT method profiling (515), compact object headers as product option (519), generational Shenandoah (521), KDF API (510), JFR cooperative sampling (518) and method timing/tracing (520), 32-bit x86 port removed (503) | structured concurrency 5th (505), stable values (502), primitive patterns 3rd (507), PEM encodings (470), Vector API (508), JFR CPU-time profiling *(experimental)* (509) |
| 26 | prepare to make final mean final (500), Applet API removed (504), AOT object caching with any GC (516), **HTTP/3 in `java.net.http.HttpClient` (517)**, G1 throughput improvement (522) | structured concurrency 6th (525), lazy constants 2nd (526), PEM 2nd (524), primitive patterns 4th (530), Vector API (529) |
| 27 | G1 default in all environments (523), post-quantum hybrid key exchange for TLS 1.3 (527), compact object headers by default (534), JFR in-process data redaction (536) | structured concurrency 7th (533), lazy constants 3rd (531), primitive patterns 5th (532), PEM 3rd (538), Vector API (537) |

String templates were previewed in 21–22 and withdrawn — do not use or recommend them.

## Records

```java
import java.math.BigDecimal;
import java.util.Currency;
import java.util.List;
import java.util.Objects;

public record Money(BigDecimal amount, Currency currency) {
  public Money {                                   // compact constructor: validate, normalise
    Objects.requireNonNull(amount, "amount");
    Objects.requireNonNull(currency, "currency");
    if (amount.scale() > currency.getDefaultFractionDigits()) {
      throw new IllegalArgumentException("scale " + amount.scale() + " > " + currency);
    }
  }

  public Money plus(Money other) {                 // "wither"-style operations return new instances
    if (!currency.equals(other.currency)) throw new IllegalArgumentException("currency mismatch");
    return new Money(amount.add(other.amount), currency);
  }
}

public record Order(String id, List<String> lines) {
  public Order {
    lines = List.copyOf(lines);                    // defensive, unmodifiable copy (rejects null elements)
  }
}
```

- Records are shallowly immutable: copy mutable components (`List.copyOf`, `Map.copyOf`, arrays).
- Do **not** use records as JPA entities (need no-arg constructor, mutable state, proxies). Use them
  for DTOs, projections, value objects, configuration properties, events.
- Jackson 2.12+/3 and Spring `@ConfigurationProperties` bind records via the canonical constructor.

## Pattern matching

```java
record Point(int x, int y) {}
record Line(Point from, Point to) {}

static int manhattan(Object shape) {
  if (shape instanceof Line(Point(var x1, var y1), Point(var x2, var y2))) {
    return Math.abs(x2 - x1) + Math.abs(y2 - y1);
  }
  throw new IllegalArgumentException("not a line: " + shape);
}

static String kind(Object o) {
  return switch (o) {
    case null -> "null";                            // explicit null case; otherwise switch throws NPE
    case Integer i when i > 100 -> "big int";
    case Integer _ -> "int";                        // `_` needs JDK 22+
    case String s -> "string of " + s.length();
    default -> "other";
  };
}
```

- Guarded cases (`when`) must come before the unguarded case of the same type (dominance is a compile error).
- Over a `sealed` hierarchy, omit `default` so new subtypes break the build where they must be handled.
- Primitive type patterns (`case int i`) are still preview in 27 — avoid.

## Unnamed variables (JDK 22)

```java
try {
  return Integer.parseInt(raw);
} catch (NumberFormatException _) {
  return fallback;
}

map.forEach((_, value) -> total.add(value));
for (var _ : batch) counter++;
```

## Sequenced collections (JDK 21)

```java
List<Event> events = loadEvents();
Event first = events.getFirst();          // NoSuchElementException when empty, like Deque
Event last = events.getLast();
List<Event> newestFirst = events.reversed();   // a view, not a copy

LinkedHashMap<String, Integer> lru = new LinkedHashMap<>();
lru.putLast("a", 1);
Map.Entry<String, Integer> oldest = lru.pollFirstEntry();
```

`List.getFirst()` also exists on `List.of(...)`. Code that called `getFirst()` on a custom `List`
subclass with a different return type may no longer compile on 21 — rename the method.

## Stream gatherers (JDK 24)

```java
import java.util.List;
import java.util.stream.Gatherers;
import java.util.stream.Stream;

List<List<Integer>> batches = Stream.of(1, 2, 3, 4, 5)
    .gather(Gatherers.windowFixed(2))      // [[1, 2], [3, 4], [5]]
    .toList();

// Bounded, order-preserving concurrent I/O on virtual threads:
List<Quote> quotes = skus.stream()
    .gather(Gatherers.mapConcurrent(16, quoteClient::fetch))   // at most 16 in flight
    .toList();
```

Other built-ins: `windowSliding`, `fold`, `scan`. `mapConcurrent` is the simplest production-grade
replacement for "parallel HTTP calls" code while structured concurrency is still preview.

## Flexible constructor bodies (JDK 25)

```java
import java.math.BigInteger;

public class PositiveBigInteger extends BigInteger {
  public PositiveBigInteger(long value) {
    if (value <= 0) {                              // prologue: may not read `this` or instance fields
      throw new IllegalArgumentException("non-positive: " + value);
    }
    super(Long.toString(value));
  }
}
```

Fail-fast validation no longer needs a static helper; fields may also be assigned before `super(...)`
so an overridden method called from the superclass constructor sees initialised state.

## Module import declarations and compact source files (JDK 25)

```java
// Tool.java — run with: java Tool.java   (compact source file, implicit `import module java.base;`)
void main() {
  var name = IO.readln("Name: ");
  IO.println("Hello " + name);
}
```

```java
import module java.sql;          // imports every package exported by java.sql (and its transitive API)
```

- Compact source files are for scripts, tools and teaching — services keep normal classes.
- In large codebases prefer explicit imports: module imports can create ambiguous simple names
  (e.g. `List` from `java.util` and `java.awt`); a single-type import resolves the clash.

## Scoped values (JDK 25)

See [concurrency.md](concurrency.md#scoped-values-instead-of-threadlocal).

## Crypto additions

```java
import java.security.spec.AlgorithmParameterSpec;
import javax.crypto.KDF;
import javax.crypto.SecretKey;
import javax.crypto.spec.HKDFParameterSpec;

KDF hkdf = KDF.getInstance("HKDF-SHA256");                  // JDK 25, JEP 510
AlgorithmParameterSpec params = HKDFParameterSpec.ofExtract()
    .addIKM(initialKeyMaterial)
    .addSalt(salt)
    .thenExpand(info, 32);
SecretKey key = hkdf.deriveKey("AES", params);
```

- ML-KEM / ML-DSA (post-quantum KEM and signatures) are final since JDK 24; hybrid PQ key exchange for
  TLS 1.3 arrives in JDK 27 (JEP 527).
- PEM encoding API is still preview (3rd preview in 27).

## HTTP/3 in the JDK client (JDK 26)

```java
var client = HttpClient.newBuilder()
    .version(HttpClient.Version.HTTP_3)       // opt-in; falls back per discovery mode
    .connectTimeout(Duration.ofSeconds(3))
    .build();
```

Always set `connectTimeout` on the client and `timeout(...)` on each `HttpRequest` — the JDK client
has no default request timeout.

## Integrity-by-default warnings (plan for them)

| Warning / change | JDK | What to do |
|---|---|---|
| Dynamic agent loading (Mockito, Byte Buddy agents) | 21+ | load agents with `-javaagent` (see build-tooling.md) |
| `System.loadLibrary`/JNI use | 24+ | `--enable-native-access=ALL-UNNAMED` (or module name) only where needed |
| `sun.misc.Unsafe` memory-access methods | 24+ warns | upgrade the library (Netty, older serializers) |
| Security Manager | 24 | permanently disabled — delete the code paths |
| Deep-reflection mutation of `final` fields | 26+ warns (`--illegal-final-field-mutation=warn` default) | fix the library; `deny` becomes the default later |
| Annotation processors on the class path | 23+ | not run unless declared (`-proc:full` or processor path) |
