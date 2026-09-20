---
name: springboot-security
description: "Spring Security 7 on Boot 4: lambda-DSL SecurityFilterChain, deny-by-default and ownership checks, method security, OAuth2 resource server/JWT, sessions, CSRF, CORS, headers, MFA, passwords, actuator, rate limits, CVEs. Use when adding or reviewing auth, endpoints, secrets or Spring Security config."
metadata:
  origin: ECC
---

# Spring Boot Security

Server-side enforcement for Spring Boot 4.x services: every request is authenticated where needed,
authorized for **this** action on **this** resource, validated, and answered without leaking details.
Baseline: **Spring Security 7.1.1** (Boot 4.1.1) / 7.0.7 (Boot 4.0.8). Spring Security 6.5 OSS support
ended 2026-06-30.

Related: `springboot-patterns` (errors, clients), `jpa-patterns` (query safety),
`java-modern/references/secure-coding.md` (deserialization, XXE, SSRF, crypto), `secret-hygiene`,
agents `java-reviewer`, `security-reviewer`, `api-security-auditor`, `permission-auditor`.

## When to Activate

- Adding login, JWT/OAuth2, sessions, passkeys or MFA
- Adding or changing endpoints, roles, ownership or tenant rules
- Configuring CSRF, CORS, security headers, actuator exposure or rate limits
- Upgrading Spring Security 6.x → 7 or reacting to a Spring advisory

## Current Advisories to Check (Aug 2026)

| CVE | Affects | Fixed in |
|---|---|---|
| CVE-2026-41707 (HIGH) DPoP proof replay via `jti` cache eviction | Security 7.1.0, 7.0.0–7.0.6, 6.5.0–6.5.11 | 7.1.1, 7.0.7 (6.5.12 commercial) |
| CVE-2026-47841 (HIGH) WebAuthn user-verification bypass with distributed sessions | Security 7.1.0, 7.0.0–7.0.6, 6.5.0–6.5.11, 6.4.0–6.4.18 | 7.1.1, 7.0.7, 6.5.12, 6.4.19 |
| CVE-2026-47834 (MEDIUM) Sort validation bypass in native queries | Spring Data JPA 4.1.0, 4.0.0–4.0.6, 3.x | 4.1.1, 4.0.7 |

Always re-check https://spring.io/security before a release; Boot patch releases pull the fixes in.

## Security 7 Breaking Changes (from 6.x)

- `and()` chaining and `authorizeRequests()` are **removed** → lambda DSL + `authorizeHttpRequests`.
- `AntPathRequestMatcher` / `MvcRequestMatcher` removed → string patterns (backed by
  `PathPatternRequestMatcher`) or `PathPatternRequestMatcher.pathPattern(HttpMethod.GET, "/api/**")`.
- `http.apply(customDsl)` → `http.with(customDsl, Customizer.withDefaults())`.
- `AccessDecisionManager`/`AccessDecisionVoter` moved to `spring-security-access`; migrate to
  `AuthorizationManager` (`check` was removed in favour of `authorize`).
- OAuth2 password grant removed; OpenSAML 4 removed (use 5); Jackson 3 (`SecurityJacksonModules`).
- Upgrade path: latest 6.5.x with its "prepare for 7" steps → Boot 4 → Security 7.

## API Filter Chain (bearer tokens, stateless)

```java
@Configuration
@EnableWebSecurity
@EnableMethodSecurity
class ApiSecurityConfig {

  @Bean
  SecurityFilterChain api(HttpSecurity http) throws Exception {
    http
        .securityMatcher("/api/**")
        .authorizeHttpRequests(auth -> auth
            .requestMatchers(HttpMethod.GET, "/api/public/**").permitAll()
            .requestMatchers("/api/admin/**").hasRole("ADMIN")
            .anyRequest().authenticated())                                  // nothing is implicitly public
        .oauth2ResourceServer(rs -> rs.jwt(Customizer.withDefaults()))
        .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
        .csrf(csrf -> csrf.disable())            // only valid because auth is a header token, never a cookie
        .cors(Customizer.withDefaults());
    return http.build();
  }
}
```

```yaml
spring:
  security:
    oauth2:
      resourceserver:
        jwt:
          issuer-uri: https://idp.example.com/realms/shop   # signature keys via discovery, iss checked
          audiences: shop-api                               # reject tokens minted for other clients
          authorities-claim-name: roles
          authority-prefix: ROLE_
```

- Use the resource server (`spring-boot-starter-security-oauth2-resource-server`), not a hand-written
  `OncePerRequestFilter` that parses JWTs: custom filters regularly miss algorithm pinning, `exp`/`nbf`,
  audience, key rotation and error handling. Issuing your own tokens: Spring Authorization Server
  (part of Spring Security 7).
- Short access-token lifetimes; refresh tokens only for confidential clients, rotated and revocable.

## Browser Session Chain (dashboards, server-rendered or SPA on the same site)

```java
@Bean
SecurityFilterChain web(HttpSecurity http) throws Exception {
  http
      .authorizeHttpRequests(auth -> auth
          .requestMatchers("/", "/login", "/assets/**").permitAll()
          .requestMatchers("/admin/**").hasRole("ADMIN")
          .anyRequest().authenticated())
      .oauth2Login(Customizer.withDefaults())             // or .formLogin(Customizer.withDefaults())
      .csrf(csrf -> csrf.spa())                            // SPA: XSRF-TOKEN cookie + BREACH-safe handler
      .logout(logout -> logout.logoutSuccessUrl("/"))
      .sessionManagement(s -> s.maximumSessions(3));
  return http.build();
}
```

```yaml
server:
  servlet:
    session:
      timeout: 30m
      cookie: { secure: true, http-only: true, same-site: lax }
```

- Keep CSRF on for anything authenticated by cookies (sessions, remember-me). `csrf.spa()` sets up
  `CookieCsrfTokenRepository.withHttpOnlyFalse()` with the matching request handler.
- Session fixation protection (new session ID on login) is on by default — don't disable it.
- Several `SecurityFilterChain` beans: the one with the most specific `securityMatcher` must be ordered
  first (`@Order`); the catch-all chain last.

## Authorization: roles, ownership, tenants

```java
@Service
class OrderService {

  @PreAuthorize("hasRole('ADMIN') or @orderAccess.isOwner(#orderId, authentication)")
  public OrderView get(long orderId) { ... }

  // Better for lists and IDOR: scope the query itself by the caller
  @Transactional(readOnly = true)
  public Page<OrderView> mine(Jwt jwt, Pageable pageable) {
    return repo.findByOwnerId(jwt.getSubject(), pageable).map(OrderView::from);
  }

  public void cancel(long orderId, Jwt jwt) {
    OrderEntity order = repo.findByIdAndOwnerId(orderId, jwt.getSubject())
        .orElseThrow(() -> new OrderNotFoundException(orderId));   // 404, not 403: don't confirm existence
    order.cancel();
  }
}
```

- The server decides who may do what; hidden buttons in the dashboard are not authorization.
- Tenant/guild/owner comes from the authenticated principal, never from the request body or a header
  the client controls.
- Every endpoint gets an explicit rule or method annotation; admin mutations get both.
- `@PreAuthorize` works through proxies: not on private or self-invoked methods (same as `@Transactional`).
- Mass assignment: bind request DTO records, never entities; server-side fields (`role`, `ownerId`,
  `status`, `price`) are never taken from input.

## MFA and Passkeys (Security 7)

```java
@EnableMultiFactorAuthentication(authorities = {
    FactorGrantedAuthority.PASSWORD_AUTHORITY, FactorGrantedAuthority.OTT_AUTHORITY })
@Configuration
class MfaConfig {}

// or only for sensitive areas:
var mfa = AuthorizationManagerFactories.multiFactor()
    .requireFactors(FactorGrantedAuthority.PASSWORD_AUTHORITY, FactorGrantedAuthority.WEBAUTHN_AUTHORITY)
    .build();
http.authorizeHttpRequests(auth -> auth
    .requestMatchers("/admin/**").access(mfa.hasRole("ADMIN"))
    .anyRequest().authenticated());
```

Passkeys: `http.webAuthn(w -> w.rpName("Shop").rpId("shop.example.com").allowedOrigins("https://shop.example.com"))`.
With Spring Session (Redis/JDBC) and `userVerification = REQUIRED`, Security ≥ 7.0.7/7.1.1 is mandatory
(CVE-2026-47841).

## Passwords

```java
@Bean
PasswordEncoder passwordEncoder() {
  return PasswordEncoderFactories.createDelegatingPasswordEncoder();   // {bcrypt} today, upgradeable via {id} prefix
}

@Bean
CompromisedPasswordChecker compromisedPasswordChecker() {
  return new HaveIBeenPwnedRestApiPasswordChecker();                    // k-anonymity range API
}
```

- Argon2: `Argon2PasswordEncoder.defaultsForSpringSecurity_v5_8()` (needs Bouncy Castle) or the
  Password4j-based encoders added in 7.0 (`Argon2Password4jPasswordEncoder`, needs Password4j).
- Implement `UserDetailsPasswordService` to re-hash on login when the encoder changes.
- Login endpoints: generic error ("invalid credentials"), rate limit per account **and** per IP,
  lockout/backoff, no user enumeration via timing or messages.

## CORS

```java
@Bean
CorsConfigurationSource corsConfigurationSource() {
  CorsConfiguration config = new CorsConfiguration();
  config.setAllowedOrigins(List.of("https://dashboard.example.com"));   // exact origins, never "*" with credentials
  config.setAllowedMethods(List.of("GET", "POST", "PUT", "PATCH", "DELETE"));
  config.setAllowedHeaders(List.of("Authorization", "Content-Type", "X-XSRF-TOKEN"));
  config.setAllowCredentials(true);
  config.setMaxAge(Duration.ofHours(1));
  UrlBasedCorsConfigurationSource source = new UrlBasedCorsConfigurationSource();
  source.registerCorsConfiguration("/api/**", config);
  return source;
}
```

CORS is not access control — it only stops browsers from reading responses. Origins come from
configuration, not from reflecting the request's `Origin` header.

## Security Headers

Defaults: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Cache-Control: no-store…`,
HSTS on HTTPS, `X-XSS-Protection: 0`. Add CSP, referrer and permissions policy:

```java
http.headers(h -> h
    .contentSecurityPolicy(csp -> csp.policyDirectives(
        "default-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"))
    .referrerPolicy(r -> r.policy(ReferrerPolicyHeaderWriter.ReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN))
    .permissionsPolicyHeader(p -> p.policy("camera=(), microphone=(), geolocation=()"))
    .httpStrictTransportSecurity(hsts -> hsts.includeSubDomains(true).maxAgeInSeconds(31_536_000)));
```

Behind a TLS-terminating proxy set `server.forward-headers-strategy=native` (and
`server.tomcat.remoteip.trusted-proxies` for non-default ranges) so HTTPS detection and client IPs are right.

## Actuator

```yaml
management:
  server.port: 8081                                   # internal port, not routed publicly
  endpoints:
    access.default: none                              # opt-in per endpoint
    web.exposure.include: health,info,prometheus
  endpoint:
    health: { access: read-only, show-details: when-authorized }
    info.access: read-only
    prometheus.access: read-only
```

Never expose `env`, `configprops`, `heapdump`, `threaddump`, `loggers`, `mappings`, `shutdown`
publicly; `show-values` for env/configprops stays `never`. With a custom `SecurityFilterChain`,
Boot's actuator auto-protection no longer applies — add a chain using Boot's `EndpointRequest` matcher.

## Rate Limiting (Bucket4j 8.x)

```java
@Component
class RateLimitFilter extends OncePerRequestFilter {
  // bounded: an unbounded Map<ip, Bucket> is itself a memory DoS
  private final Cache<String, Bucket> buckets = Caffeine.newBuilder()
      .maximumSize(100_000).expireAfterAccess(Duration.ofMinutes(10)).build();

  @Override
  protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res, FilterChain chain)
      throws ServletException, IOException {
    String key = req.getRemoteAddr();              // correct only with forward-headers-strategy + trusted proxies
    Bucket bucket = buckets.get(key, k -> Bucket.builder()
        .addLimit(limit -> limit.capacity(100).refillGreedy(100, Duration.ofMinutes(1)))
        .build());
    ConsumptionProbe probe = bucket.tryConsumeAndReturnRemaining(1);
    if (probe.isConsumed()) {
      chain.doFilter(req, res);
    } else {
      res.setStatus(HttpStatus.TOO_MANY_REQUESTS.value());
      res.setHeader(HttpHeaders.RETRY_AFTER, String.valueOf(
          TimeUnit.NANOSECONDS.toSeconds(probe.getNanosToWaitForRefill()) + 1));
    }
  }
}
```

- Artifact `com.bucket4j:bucket4j_jdk17-core` (8.20.x); `Bandwidth.classic`/`Refill` are deprecated.
- Never read `X-Forwarded-For` yourself. Multiple instances: a shared backend (Bucket4j Redis/JDBC
  proxy manager) or gateway limits. Key authenticated traffic by user/API key, not only IP.

## Input, Output, Uploads

- Bean Validation on every request DTO (`@Valid`), `@Validated` for path/query parameters, `@Size`
  limits on strings and collections.
- Queries: parameters only; `Sort`/`Pageable` properties allowlisted (`jpa-patterns`).
- Errors: `ProblemDetail` without exception messages or stack traces (`springboot-patterns`).
- Uploads: `spring.servlet.multipart.max-file-size` / `max-request-size`, content sniffing (magic bytes),
  generated file names, storage outside static resources.
- Outbound calls to user-supplied URLs: allowlist + Boot 4.1 `InetAddressFilter` (SSRF).

## Secrets and Logging

- Secrets from environment / secret store only (`${DB_PASSWORD}`, `configtree:`, Vault); none in
  `application*.yml`, tests or Docker images. Rotate anything that was committed (`secret-hygiene`).
- Never log tokens, passwords, `Authorization`/`Cookie` headers, session IDs or personal data.

## Testing Security Rules

```java
@WebMvcTest(OrderController.class)
@Import(ApiSecurityConfig.class)
class OrderSecurityTest {
  @Autowired MockMvcTester mvc;
  @MockitoBean OrderService orders;
  @MockitoBean JwtDecoder jwtDecoder;          // no IdP needed; jwt() below bypasses decoding

  @Test void anonymousIsRejected() {
    assertThat(mvc.get().uri("/api/orders/1")).hasStatus(HttpStatus.UNAUTHORIZED);
  }

  @Test void userCannotUseAdminEndpoint() {
    assertThat(mvc.delete().uri("/api/admin/orders/1").with(jwt().authorities(new SimpleGrantedAuthority("ROLE_USER"))))
        .hasStatus(HttpStatus.FORBIDDEN);
  }
}
```

`spring-boot-starter-security-test`; `jwt()`, `csrf()`, `user()` come from
`SecurityMockMvcRequestPostProcessors`. Test the **denied** paths for every role, not only the happy path.

## Checklist Before Release

- [ ] Spring Boot / Security / Data on patched versions (advisories above), OSS-supported line
- [ ] Every endpoint has an explicit rule; `anyRequest()` is `authenticated()` or `denyAll()`
- [ ] Ownership/tenant checks in the service or query, deny paths tested (401/403/404)
- [ ] CSRF correct for the auth type; CORS exact origins
- [ ] Resource server validates issuer and audience; no custom JWT parsing
- [ ] Passwords via delegating encoder; login rate-limited
- [ ] Headers incl. CSP; HTTPS + HSTS; forward headers trusted only from the proxy
- [ ] Actuator minimal and not public
- [ ] Inputs validated and size-limited; errors without internals; no secrets in logs or config
