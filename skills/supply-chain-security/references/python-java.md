# Python and Java supply-chain controls

Verified 2026-09-18 (uv docs, pip 26.2.1, Gradle 9.7.1, Maven 3.9.16 / 4.0.0-rc-6). Project setup
beyond supply chain: `python-modern-stack` (Python) and `java-modern` (Java) skills.

## Python

### uv (preferred)

```toml
# pyproject.toml
[tool.uv]
exclude-newer = "7 days"          # rolling cooldown; accepts "24 hours", "1 week", RFC 3339 or ISO 8601 durations
# exclude-newer-package = { my-internal-lib = false }   # exempt a package from the cooldown
no-build = true                   # wheels only for dependencies: no setup.py/build backends run at install
```

```bash
uv lock                           # resolve and write uv.lock (commit it)
uv sync --locked                  # CI: fail if uv.lock is out of date with pyproject.toml
UV_MALWARE_CHECK=1 uv sync        # opt-in OSV malware lookup, aborts before anything runs
uv audit                          # vulnerability + adverse-status scan of uv.lock (preview since 2026-06)
```

Relative `exclude-newer` durations need uv >= 0.9.17. `no-build` still builds your own workspace
packages.

### pip

```bash
# hash-locked requirements (generate with uv or pip-tools)
uv pip compile requirements.in --generate-hashes -o requirements.txt
pip install --require-hashes --only-binary :all: -r requirements.txt

# cooldown (pip >= 26.0 absolute timestamps, >= 26.1 ISO 8601 durations)
pip install --uploaded-prior-to P7D -r requirements.txt

pip-audit -r requirements.txt     # PyPA advisory DB + OSV
```

`--require-hashes` is implied as soon as any line has `--hash`. `--only-binary :all:` fails for
packages without wheels; allow specific sdists with `--only-binary :all: --no-binary <pkg>` only
after review.

### PyPI-specific risks

- Typosquats and dependency confusion (a public package with your internal name). Use one index
  (`--index-url`) and never `--extra-index-url` for private packages; uv's default
  `index-strategy = "first-index"` already refuses to mix indexes for the same name.
- Mini Shai-Hulud (May 2026) crossed from npm into PyPI (Mistral AI, guardrails-ai). A Python-only
  project with a JS toolchain in CI is exposed to npm incidents too.
- Publishing: PyPI trusted publishing via `pypa/gh-action-pypi-publish` (OIDC, PEP 740 attestations).

## Java

### Gradle

```kotlin
// build.gradle.kts: lock every configuration
dependencyLocking { lockAllConfigurations() }

// only fetch company groups from the internal repo (blocks dependency confusion)
repositories {
    exclusiveContent {
        forRepository { maven { url = uri("https://repo.example.internal/maven") } }
        filter { includeGroupByRegex("com\\.example\\..*") }
    }
    mavenCentral()
}
```

```bash
./gradlew dependencies --write-locks                          # writes gradle.lockfile (commit)
./gradlew --write-verification-metadata sha256,pgp help       # writes gradle/verification-metadata.xml
./gradlew --dependency-verification lenient build             # temporary, while fixing failures
```

- Verification is enforced automatically once `gradle/verification-metadata.xml` exists. A build that
  starts failing verification without a dependency change is the first sign of a tampered artifact.
- Wrapper: set `distributionSha256Sum` in `gradle/wrapper/gradle-wrapper.properties` (values on
  gradle.org/release-checksums). `gradle/actions/setup-gradle` v4+ validates `gradle-wrapper.jar`
  checksums on every run; otherwise use `gradle/actions/wrapper-validation`.

### Maven

- Exact versions only: no ranges, `LATEST`, `RELEASE` or SNAPSHOTs in releases. Enforce with
  `maven-enforcer-plugin` 3.6.x rules `banDynamicVersions`, `requireUpperBoundDeps`,
  `dependencyConvergence`.
- `mvn -C` (`--strict-checksums`) fails the build on checksum mismatch.
- Route every repository through one repository manager (`<mirrorOf>*</mirrorOf>` in
  `settings.xml`) so a public artifact cannot shadow an internal one.
- Maven Wrapper 3.3.x: pin `distributionSha256Sum` (and `wrapperSha256Sum`) in
  `.mvn/wrapper/maven-wrapper.properties`.
- Maven 4 is still a release candidate (4.0.0-rc-6); stay on 3.9.x for production builds.
- `org.mvnpm:*` artifacts are npm packages mirrored into Maven Central (Shai-Hulud 2.0 reached
  `org.mvnpm:posthog-node:4.18.1`). Treat them with npm-level scrutiny.

### Scanning

```bash
osv-scanner scan source -r .     # pom.xml, gradle.lockfile, verification-metadata.xml
```

OWASP dependency-check (Maven plugin `org.owasp:dependency-check-maven` 13.0.0) needs a free NVD
API key; read it from the environment, never from the POM:

```xml
<plugin>
  <groupId>org.owasp</groupId>
  <artifactId>dependency-check-maven</artifactId>
  <version>13.0.0</version>
  <configuration>
    <nvdApiKeyEnvironmentVariable>NVD_API_KEY</nvdApiKeyEnvironmentVariable>
    <failBuildOnCVSS>7</failBuildOnCVSS>
  </configuration>
</plugin>
```

Dependabot supports `cooldown` for `maven` and `gradle` ecosystems.

## Sources

- uv settings: https://docs.astral.sh/uv/reference/settings/
- uv audit: https://astral.sh/blog/uv-audit
- pip install options: https://pip.pypa.io/en/stable/cli/pip_install/
- pip 26 cooldowns: https://sethmlarson.dev/pip-relative-dependency-cooling-with-crontab
- Gradle dependency verification: https://docs.gradle.org/current/userguide/dependency_verification.html
- Gradle wrapper validation: https://github.com/gradle/actions/blob/main/docs/wrapper-validation.md
- Maven Central metadata (versions): https://repo1.maven.org/maven2/org/owasp/dependency-check-maven/maven-metadata.xml
- Shai-Hulud on Maven Central: https://advisories.gitlab.com/pkg/maven/org.mvnpm/posthog-node/GMS-2025-800/
- Dependabot cooldown ecosystems: https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference
