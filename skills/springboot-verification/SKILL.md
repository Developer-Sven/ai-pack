---
name: springboot-verification
description: "Pre-PR and pre-deploy gate for Spring Boot: wrapper build, tests and JaCoCo, SpotBugs+FindSecBugs, dependency CVEs (OSV-Scanner, dependency-check), secrets, actuator/config exposure, supported-version check, report. Use when preparing a PR or release, or after dependency upgrades."
metadata:
  origin: ECC
---

# Spring Boot Verification Loop

Run before PRs, after dependency upgrades and before deploys. Stop at the first failing phase, fix,
re-run from that phase. Report what actually ran — a skipped phase is reported as skipped, never as
passed.

Related: `springboot-tdd` (writing tests), `springboot-security` (what the config should look like),
`java-modern/references/build-tooling.md` (plugin setup), `supply-chain-security` (lockfiles,
verification metadata), agent `java-reviewer` (code review of the diff).

## When to Activate

- Before opening a PR for a Spring Boot service
- After bumping Spring Boot, Spring Security, Hibernate, Jackson or the JDK
- Before a staging/production deploy
- When CI is green but you need evidence (coverage, CVEs, exposure) for sign-off

## Phase 0: Toolchain and Support Status

```bash
java -version && ./mvnw -v            # or: ./gradlew -v   — always the wrapper, never a global mvn/gradle
./mvnw -q help:evaluate -Dexpression=project.parent.version -DforceStdout   # Boot version (parent POM)
./mvnw -q dependency:tree -Dincludes=org.springframework.security,org.springframework.data,tools.jackson.core
```

Fail the gate (or open a tracked upgrade task) when:
- Spring Boot is below the supported lines: 4.1.x (OSS to 2027-07-31) and 4.0.x (OSS to 2026-12-31).
  3.5.x OSS support ended 2026-06-30.
- Spring Security < 7.1.1 / 7.0.7 or Spring Data JPA < 4.1.1 / 4.0.7 (CVE-2026-41707, -47841, -47834).
- The JDK is not an LTS in support (25 preferred, 21 acceptable; Oracle JDK 21 builds after the
  October 2026 CPU are no longer free for production).

## Phase 1: Compile

```bash
./mvnw -B -ntp clean test-compile          # compiles main + tests
./gradlew clean testClasses
```

- Treat new compiler warnings as findings (`-Xlint:all`), especially deprecations: Boot 4 deprecates
  `spring-boot-starter-web`, Jackson 2 support and several properties.
- Boot 4.1: `-DskipTests` no longer skips test AOT processing — use `-Dmaven.test.skip=true` when you
  really need to skip tests entirely (never for this gate).

## Phase 2: Tests and Coverage

```bash
./mvnw -B -ntp verify                      # Surefire unit + Failsafe *IT + JaCoCo check (if bound)
./gradlew check jacocoTestReport
```

Report: tests run/failed/skipped, coverage (line/branch) from `target/site/jacoco/index.html` or
`build/reports/jacoco/test/html/index.html`. Gate: JaCoCo `check` rule (≥ 80 % line, ≥ 70 % branch as
default) and zero `@Disabled` tests added without an issue reference.

Integration tests need Docker for Testcontainers; if Docker is unavailable say so — don't report them
as passed.

## Phase 3: Static Analysis

```bash
./mvnw -B -ntp compile spotbugs:check      # SpotBugs 4.10.x + FindSecBugs 1.14.0 (needs compiled classes)
./mvnw -B -ntp spotless:check              # formatting, if configured
./mvnw -B -ntp checkstyle:check pmd:check  # only if the project configures them
./gradlew spotbugsMain spotlessCheck
```

FindSecBugs findings in categories SQL/command/path injection, XXE, unsafe deserialization, SpEL,
predictable random, weak crypto and SSRF are release blockers until fixed or justified in writing.

## Phase 4: Dependency Vulnerabilities

```bash
osv-scanner scan source -r .               # resolves pom.xml transitively; gradle.lockfile; verification-metadata.xml
./mvnw -B -ntp org.owasp:dependency-check-maven:13.0.0:check \
  -DnvdApiKeyEnvironmentVariable=NVD_API_KEY -DfailBuildOnCVSS=7
./gradlew dependencyCheckAnalyze           # org.owasp.dependencycheck plugin 13.0.0
```

- The NVD API key comes from the CI secret store (`NVD_API_KEY`), never from the POM.
- Fix by bumping the Boot BOM/patch release first; override single managed versions via their
  property (`<jackson-bom.version>`, `<tomcat.version>`) only as a stop-gap with a removal note.
- Check https://spring.io/security for advisories that scanners may not map yet.

## Phase 5: Secrets and Configuration Exposure

```bash
# Secrets (see secret-hygiene audit mode; gitleaks if installed: gitleaks git .)
grep -rnE "(password|secret|token|api[_-]?key)\s*[:=]\s*[^$\{ ]" src/main/resources/ --include="application*"

# Risky configuration
grep -rnE "exposure\.include\s*[:=]\s*['\"]?\*|show-values\s*[:=]\s*always|ddl-auto\s*[:=]\s*(update|create)" src/main/resources/
grep -rn "open-in-view" src/main/resources/            # must be false
grep -rnE "csrf\(.*disable|permitAll\(\)|allowedOrigins.*\*|@CrossOrigin" src/main/java/

# Dangerous APIs
grep -rnE "ObjectInputStream|StandardEvaluationContext|JpaSort\.unsafe|Runtime\.getRuntime\(\)\.exec|InitialContext" src/main/java/
grep -rnE "System\.out\.print|printStackTrace\(\)" src/main/java/
```

Every hit is either fixed or explained: `csrf.disable()` only for bearer-token APIs without cookies,
each `permitAll()` intentional, actuator minimal and not public.

## Phase 6: Runtime Smoke Test

```bash
SPRING_PROFILES_ACTIVE=prod-like ./mvnw spring-boot:run    # or the built image with prod-like config
curl -fsS localhost:8080/actuator/health                    # UP
curl -s -o /dev/null -w "%{http_code}\n" localhost:8080/api/orders   # 401 without a token
```

Read the startup log: no `WARN` about deprecated/renamed properties (`spring-boot-properties-migrator`
during upgrades), no Mockito self-attach or JDK restricted-method warnings in tests, no stack traces,
no secrets printed. Stop the app afterwards.

## Phase 7: Diff Review

```bash
git diff --stat
git diff
```

Checklist:
- No debug output (`System.out`, temporary `log.info` of payloads), no commented-out code
- Every new endpoint: validation, authorization rule, ownership check, test for the denied path
- Transactions on the service layer; no remote calls inside transactions
- Config changes documented; new properties actually read; migrations included for schema changes
- Run `java-reviewer` on the changed Java files before committing

## Output Template

```
VERIFICATION REPORT (Spring Boot x.y.z, JDK nn)
================================================
Toolchain/Support: [PASS/FAIL] (Boot line, Security/Data patch level)
Compile:           [PASS/FAIL] (new warnings: N)
Tests:             [PASS/FAIL/SKIPPED] (X/Y passed, IT: ran/skipped-no-docker)
Coverage:          line A% / branch B%  [PASS/FAIL vs gate]
Static analysis:   [PASS/FAIL/NOT CONFIGURED] (SpotBugs+FindSecBugs: N)
Dependencies:      [PASS/FAIL] (OSV: N, dependency-check CVSS>=7: M)
Secrets/Config:    [PASS/FAIL] (findings: N)
Smoke test:        [PASS/FAIL/NOT RUN]
Diff:              [X files changed]

Overall: [READY / NOT READY]

Issues to fix:
1. ...
```

## Continuous Mode

- Inner loop while coding: `./mvnw -q -Dtest=ChangedClassTest test` + `spotbugs:check` on touched modules.
- Full gate before every PR and after every dependency bump; re-run Phase 4 at least weekly on
  long-lived branches — new CVEs appear without code changes.

**Remember**: evidence over assertion — the report lists commands that ran and their results.
