# Secure Java: vulnerable → fixed

Framework-independent. Spring Security configuration lives in `springboot-security`; supply chain in
`supply-chain-security`. Sources: Oracle "Java Serialization Filters" (JDK 25), `java.xml` module
summary (JDK 25), OWASP cheat sheets (XXE, Deserialization, SSRF), Spring Boot "HTTP clients" reference.

## Deserialization

```java
// VULNERABLE: any gadget class on the class path can run code
Object o = new ObjectInputStream(untrusted).readObject();

// FIXED 1: do not use Java serialization for external data — JSON with explicit target types
Order order = jsonMapper.readValue(body, Order.class);

// FIXED 2 (legacy formats you cannot drop): allowlist per stream
ObjectInputStream in = new ObjectInputStream(input);
in.setObjectInputFilter(ObjectInputFilter.Config.createFilter(
    "com.example.dto.*;java.base/*;!*;maxdepth=20;maxrefs=10000;maxbytes=1048576"));
```

JVM-wide fallback: `-Djdk.serialFilter=com.example.dto.*;java.base/*;!*` — filtering is **off** by
default. Jackson: never enable default typing without a validator; never `@JsonTypeInfo(use = Id.CLASS)`
on types bound from requests. If polymorphism is needed, use `Id.NAME` with `@JsonSubTypes`, or
`BasicPolymorphicTypeValidator.builder().allowIfSubType("com.example.dto.").build()`.
Jackson 3 (`tools.jackson.*`, default in Spring Boot 4) removed the permissive public validator.

## XML (XXE, billion laughs)

```java
DocumentBuilderFactory dbf = DocumentBuilderFactory.newInstance();
dbf.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);   // no DTDs at all
dbf.setFeature(XMLConstants.FEATURE_SECURE_PROCESSING, true);
dbf.setXIncludeAware(false);
dbf.setExpandEntityReferences(false);

XMLInputFactory xif = XMLInputFactory.newFactory();                             // StAX
xif.setProperty(XMLInputFactory.SUPPORT_DTD, false);
xif.setProperty(XMLInputFactory.IS_SUPPORTING_EXTERNAL_ENTITIES, false);
```

JVM-wide backstop (JDK 22+): `-Djdk.xml.dtd.support=deny` (or `ignore`). Apply the same to
`SAXParserFactory`, `TransformerFactory` (`ACCESS_EXTERNAL_DTD`/`ACCESS_EXTERNAL_STYLESHEET` = `""`),
`SchemaFactory`, and third-party parsers (dom4j, JDOM, Jackson XML).

## Expression, template and lookup injection

```java
// VULNERABLE: user input evaluated with full type access (T(java.lang.Runtime).getRuntime().exec(...))
parser.parseExpression(userInput).getValue(new StandardEvaluationContext(root));

// FIXED: never parse user input as an expression; if data binding is required, restrict the context
EvaluationContext ctx = SimpleEvaluationContext.forReadOnlyDataBinding().build();
parser.parseExpression("name").getValue(ctx, root);
```

- `InitialContext.lookup(userInput)` → JNDI injection (Log4Shell class). Never look up names from input.
- `ScriptEngine.eval`, Groovy `Eval`, OGNL/MVEL, template engines rendering **user-supplied templates**
  (Thymeleaf/FreeMarker/Velocity) → code execution. Templates come from the classpath only; user data
  goes in the model.
- Log4j 2 ≥ 2.17.1 (Boot manages 2.25.x) — do not re-enable message lookups.

## OS commands

```java
// VULNERABLE: shell parses metacharacters
Runtime.getRuntime().exec("sh -c convert " + fileName + " out.png");

// FIXED: no shell, argument list, allowlisted input, bounded runtime
if (!fileName.matches("[a-zA-Z0-9_-]{1,64}\\.png")) throw new IllegalArgumentException("bad name");
Process p = new ProcessBuilder("convert", fileName, "out.png")
    .directory(workDir.toFile())
    .redirectErrorStream(true)
    .start();
if (!p.waitFor(30, TimeUnit.SECONDS)) { p.destroyForcibly(); throw new TimeoutException("convert"); }
```

## Paths and archives

```java
Path base = uploadRoot.toRealPath();
Path target = base.resolve(userSuppliedName).normalize();
if (!target.startsWith(base)) throw new SecurityException("path traversal");

// Zip slip: same check for every entry, plus size/count limits against zip bombs
for (ZipEntry e; (e = zin.getNextEntry()) != null; ) {
  Path out = base.resolve(e.getName()).normalize();
  if (!out.startsWith(base)) throw new SecurityException("zip slip: " + e.getName());
  if (++entries > 10_000) throw new IOException("too many entries");
  // copy with a byte budget, not Files.copy(zin, out) unbounded
}
```

Store uploads outside the web root under generated names (UUID), validate type by content (magic
bytes), never trust `Content-Type` or the extension alone.

## SSRF (server-side HTTP to user-supplied URLs)

- Prefer IDs over URLs (the user picks `avatarId`, the server knows the URL).
- If URLs are unavoidable: allowlist scheme (`https`) and host, resolve DNS, reject private,
  loopback, link-local (169.254.169.254 metadata), and multicast addresses, disable redirects or
  re-validate each hop, set connect/read timeouts and a response size cap.
- Spring Boot 4.1: `InetAddressFilter` enforces the address check inside the HTTP client
  (`org.springframework.boot.http.client`):

```java
HttpClientSettings settings = HttpClientSettings.defaults()
    .withInetAddressFilter(InetAddressFilter.externalAddresses());
RestClient client = RestClient.builder()
    .requestFactory(ClientHttpRequestFactoryBuilder.jdk().build(settings))
    .build();
// or globally: a @Bean InetAddressFilter httpClientInetAddressFilter()
```

## Queries

```java
// VULNERABLE
em.createQuery("select u from User u where u.name = '" + name + "'");
jdbc.queryForList("select * from users order by " + sortParam);

// FIXED
em.createQuery("select u from User u where u.name = :name", User.class).setParameter("name", name);
// ORDER BY cannot be a bind parameter: map to an allowlist
String column = switch (sortParam) { case "name" -> "name"; case "created" -> "created_at"; default -> "id"; };
```

- Spring Data: validate `Sort`/`Pageable` properties against an allowlist, cap `size`
  (`spring.data.web.pageable.max-page-size`), never `JpaSort.unsafe(userInput)`.
  CVE-2026-47834 (Sort bypass in native queries) is fixed in Spring Data JPA 4.1.1 / 4.0.7.
- MongoDB (driver or Spring Data): never build `Document`/`BasicQuery` JSON from strings or pass
  request maps through as filters — operator injection (`{"$ne": null}`, `$where`). Bind typed values
  (`Filters.eq("email", email)`, `Criteria.where("email").is(email)`) and reject keys starting with `$`.
- LDAP: escape filter values; XPath: parameterized `XPathVariableResolver`.

## Crypto and secrets

| Need | Use | Never |
|---|---|---|
| tokens, IDs, reset codes | `SecureRandom` (`new SecureRandom()`), 128+ bits, Base64url | `Random`, `Math.random`, `UUID` as a secret |
| password storage | Spring Security `PasswordEncoder` (delegating: bcrypt default, Argon2 option) | SHA-*/MD5, unsalted hashes |
| symmetric encryption | `AES/GCM/NoPadding`, fresh 12-byte IV per message, 128-bit tag | ECB, CBC without MAC, static IV |
| key derivation | `javax.crypto.KDF` HKDF (JDK 25) / PBKDF2 for passwords | truncating hashes |
| secret comparison | `MessageDigest.isEqual(a, b)` | `Arrays.equals`, `String.equals` |
| TLS | JDK defaults (TLS 1.3/1.2), hostname verification on | custom `TrustManager` that trusts all |

Secrets come from the environment or a secret store (`spring.config.import=optional:configtree:/run/secrets/`,
Vault), never from committed `application*.yml`; see `secret-hygiene`.

## Denial of service

- Regex on user input: bound input length first; avoid nested quantifiers (`(a+)+`); JDK regex has
  no timeout.
- Request bodies: size limits (`server.tomcat.max-swallow-size`, `spring.servlet.multipart.max-file-size`,
  Jackson `StreamReadConstraints` — Jackson 2.15+/3 enforce defaults for number/string/nesting size).
- Unbounded collections from input (`List<Item>` with 10⁶ entries): `@Size(max = …)` on DTOs.
- Thread/connection exhaustion: timeouts on every outbound call, bounded executors or semaphores.

## Logging

Log IDs, not payloads. Never log passwords, tokens, `Authorization` headers, session IDs, full card
numbers or personal data; strip CR/LF from user values in plain-text logs (structured JSON logging
avoids log forging). Exceptions to clients: generic message + correlation ID, details only in logs.
