# Build tooling: Maven and Gradle snippets (Sept 2026)

Versions checked against Maven Central / Gradle services on 2026-09-18. Inside a Spring Boot project
let the Boot BOM manage library and plugin versions and pin only what it does not manage.
Lockfiles, dependency verification, repository filtering and cooldowns: `supply-chain-security`
(`references/python-java.md`).

## Maven (3.9.16)

```xml
<properties>
  <maven.compiler.release>25</maven.compiler.release>        <!-- Boot parent: <java.version>25</java.version> -->
  <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
  <argLine/>                                                  <!-- lets @{argLine} resolve without JaCoCo -->
</properties>

<build>
  <plugins>
    <!-- JDK 23+: processors on the class path no longer run. Declare every processor. -->
    <plugin>
      <groupId>org.apache.maven.plugins</groupId>
      <artifactId>maven-compiler-plugin</artifactId>
      <configuration>
        <compilerArgs>
          <arg>-parameters</arg>
          <arg>-Xlint:all,-processing,-serial</arg>
        </compilerArgs>
        <annotationProcessorPaths>
          <path><groupId>org.projectlombok</groupId><artifactId>lombok</artifactId><version>${lombok.version}</version></path>
          <path><groupId>org.mapstruct</groupId><artifactId>mapstruct-processor</artifactId><version>${mapstruct.version}</version></path>
          <path><groupId>org.hibernate.orm</groupId><artifactId>hibernate-processor</artifactId><version>${hibernate.version}</version></path>
        </annotationProcessorPaths>
      </configuration>
    </plugin>

    <!-- Mockito inline mock maker as a real agent (JDK 21+ warns on self-attach, JEP 451) -->
    <plugin>
      <groupId>org.apache.maven.plugins</groupId>
      <artifactId>maven-dependency-plugin</artifactId>
      <executions><execution><goals><goal>properties</goal></goals></execution></executions>
    </plugin>
    <plugin>
      <groupId>org.apache.maven.plugins</groupId>
      <artifactId>maven-surefire-plugin</artifactId>
      <configuration>
        <argLine>@{argLine} -javaagent:${org.mockito:mockito-core:jar}</argLine>
      </configuration>
    </plugin>

    <plugin>
      <groupId>org.apache.maven.plugins</groupId>
      <artifactId>maven-enforcer-plugin</artifactId>
      <executions>
        <execution>
          <id>enforce</id>
          <goals><goal>enforce</goal></goals>
          <configuration>
            <rules>
              <requireJavaVersion><version>[25,)</version></requireJavaVersion>
              <requireMavenVersion><version>[3.9.6,)</version></requireMavenVersion>
              <banDuplicatePomDependencyVersions/>
              <dependencyConvergence/>
            </rules>
          </configuration>
        </execution>
      </executions>
    </plugin>

    <plugin>
      <groupId>org.jacoco</groupId>
      <artifactId>jacoco-maven-plugin</artifactId>
      <version>0.8.15</version>                              <!-- 0.8.14+ for JDK 25, 0.8.15 for 26 -->
      <executions>
        <execution><id>agent</id><goals><goal>prepare-agent</goal></goals></execution>
        <execution><id>report</id><phase>verify</phase><goals><goal>report</goal></goals></execution>
        <execution>
          <id>check</id><goals><goal>check</goal></goals>
          <configuration>
            <rules><rule><element>BUNDLE</element><limits>
              <limit><counter>LINE</counter><value>COVEREDRATIO</value><minimum>0.80</minimum></limit>
              <limit><counter>BRANCH</counter><value>COVEREDRATIO</value><minimum>0.70</minimum></limit>
            </limits></rule></rules>
          </configuration>
        </execution>
      </executions>
    </plugin>

    <plugin>
      <groupId>com.github.spotbugs</groupId>
      <artifactId>spotbugs-maven-plugin</artifactId>
      <version>4.10.4.1</version>
      <configuration>
        <effort>Max</effort>
        <threshold>Medium</threshold>
        <plugins>
          <plugin><groupId>com.h3xstream.findsecbugs</groupId><artifactId>findsecbugs-plugin</artifactId><version>1.14.0</version></plugin>
        </plugins>
      </configuration>
      <executions><execution><goals><goal>check</goal></goals></execution></executions>
    </plugin>
  </plugins>
</build>
```

- Lombok per JDK: 1.18.40 (25), 1.18.46 (26), 1.18.48 (27). Without `annotationProcessorPaths` on
  JDK 23+ the symptom is `cannot find symbol` for getters/builders — not a Lombok bug.
- `-parameters` keeps parameter names for Spring (`@PathVariable` without names, `@ConfigurationProperties`
  constructor binding); the Spring Boot parent already sets it.
- OWASP dependency-check 13.0.0 (needs an NVD API key; read it from the environment):

  ```xml
  <plugin>
    <groupId>org.owasp</groupId>
    <artifactId>dependency-check-maven</artifactId>
    <version>13.0.0</version>
    <configuration>
      <nvdApiKeyEnvironmentVariable>NVD_API_KEY</nvdApiKeyEnvironmentVariable>
      <failBuildOnCVSS>7</failBuildOnCVSS>
      <formats><format>HTML</format><format>SARIF</format></formats>
    </configuration>
  </plugin>
  ```

### Error Prone 2.50.0 + NullAway 0.14.1 (optional strictness gate)

Error Prone must run on JDK 21+. `.mvn/jvm.config`:

```
--add-exports jdk.compiler/com.sun.tools.javac.api=ALL-UNNAMED
--add-exports jdk.compiler/com.sun.tools.javac.file=ALL-UNNAMED
--add-exports jdk.compiler/com.sun.tools.javac.main=ALL-UNNAMED
--add-exports jdk.compiler/com.sun.tools.javac.model=ALL-UNNAMED
--add-exports jdk.compiler/com.sun.tools.javac.parser=ALL-UNNAMED
--add-exports jdk.compiler/com.sun.tools.javac.processing=ALL-UNNAMED
--add-exports jdk.compiler/com.sun.tools.javac.tree=ALL-UNNAMED
--add-exports jdk.compiler/com.sun.tools.javac.util=ALL-UNNAMED
--add-opens jdk.compiler/com.sun.tools.javac.code=ALL-UNNAMED
--add-opens jdk.compiler/com.sun.tools.javac.comp=ALL-UNNAMED
```

```xml
<compilerArgs>
  <arg>-XDcompilePolicy=simple</arg>
  <arg>--should-stop=ifError=FLOW</arg>
  <arg>-XDaddTypeAnnotationsToSymbol=true</arg>
  <arg>-Xplugin:ErrorProne -XepOpt:NullAway:OnlyNullMarked=true</arg>
</compilerArgs>
<annotationProcessorPaths>
  <path><groupId>com.google.errorprone</groupId><artifactId>error_prone_core</artifactId><version>2.50.0</version></path>
  <path><groupId>com.uber.nullaway</groupId><artifactId>nullaway</artifactId><version>0.14.1</version></path>
  <!-- plus Lombok/MapStruct paths from above -->
</annotationProcessorPaths>
```

Mark packages with JSpecify `@NullMarked` (`org.jspecify:jspecify` 1.0.x) in `package-info.java`;
NullAway then checks only those packages. Spring Framework 7 / Boot 4 APIs are JSpecify-annotated.

## Gradle (9.7.1, Kotlin DSL)

Gradle 9 runs on JVM 17–26 (not 27 yet); Java 25 needs Gradle ≥ 9.1, Java 26 ≥ 9.4.

```kotlin
import net.ltgt.gradle.errorprone.errorprone

plugins {
    java
    jacoco
    id("com.github.spotbugs") version "6.5.11"
    id("net.ltgt.errorprone") version "5.1.1"
    id("org.owasp.dependencycheck") version "13.0.0"
}

java { toolchain { languageVersion = JavaLanguageVersion.of(25) } }

val mockitoAgent = configurations.create("mockitoAgent")

dependencies {
    compileOnly("org.projectlombok:lombok:1.18.48")
    annotationProcessor("org.projectlombok:lombok:1.18.48")      // explicit processor path (JDK 23+)
    testImplementation(platform("org.junit:junit-bom:6.1.3"))
    testImplementation("org.junit.jupiter:junit-jupiter")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher") // required since Gradle 9
    testImplementation("org.mockito:mockito-core:5.23.0")
    mockitoAgent("org.mockito:mockito-core:5.23.0") { isTransitive = false }
    spotbugsPlugins("com.h3xstream.findsecbugs:findsecbugs-plugin:1.14.0")
    errorprone("com.google.errorprone:error_prone_core:2.50.0")
    errorprone("com.uber.nullaway:nullaway:0.14.1")
}

tasks.withType<JavaCompile>().configureEach {
    options.compilerArgs.addAll(listOf("-parameters", "-Xlint:all,-processing,-serial"))
    options.errorprone.option("NullAway:OnlyNullMarked", "true")
}

tasks.test {
    useJUnitPlatform()
    jvmArgs("-javaagent:${mockitoAgent.asPath}")
    finalizedBy(tasks.jacocoTestReport)
}

jacoco { toolVersion = "0.8.15" }

dependencyCheck {
    nvd { apiKey = System.getenv("NVD_API_KEY") }
    failBuildOnCVSS = 7f
}
```

- With the Spring Boot plugin, drop explicit versions the Boot BOM manages (JUnit, Mockito) but keep
  the agent configuration at the same Mockito version.
- `gradle.properties`: `org.gradle.configuration-cache=true`, `org.gradle.caching=true`,
  `org.gradle.parallel=true`. Configuration cache is the preferred mode in Gradle 9; plugins that are
  not compatible fall back with a warning.
- Upgrade: `./gradlew wrapper --gradle-version 9.7.1 && ./gradlew wrapper`, then run with
  `--warning-mode all` and fix deprecations before the next major.

## Maven 4 (release candidate)

4.0.0-rc-6 as of Sept 2026: needs Java 17 to run, POM model 4.1.0 (`<subprojects>` replaces
`<modules>`, `bom` packaging, consumer POM flattening, built-in CI-friendly `${revision}`), resume with
`mvn verify -r`, and the `mvnup` tool to migrate POMs. Maven 3 plugins that use Plexus-style injection
can fail. Try it on a branch with `-Dmaven.plugin.validation=verbose`; keep 3.9.x in production CI.

## CI order (fail fast, cheap first)

1. `./mvnw -B -ntp verify` / `./gradlew build` on the pinned JDK (toolchain + wrapper, never a floating image tag).
2. Unit tests → integration tests (Failsafe `*IT` / Gradle test suites with Testcontainers).
3. JaCoCo check, SpotBugs + FindSecBugs, optional Error Prone/NullAway.
4. `osv-scanner scan source -r .` (pom.xml resolved transitively, `gradle.lockfile`,
   `gradle/verification-metadata.xml`) and dependency-check with the NVD key from CI secrets.
5. SBOM (`org.cyclonedx:cyclonedx-maven-plugin` 2.9.x / `org.cyclonedx.bom` Gradle plugin 3.x) and image build.

## Automated upgrades (OpenRewrite)

```bash
./mvnw -U org.openrewrite.maven:rewrite-maven-plugin:run \
  -Drewrite.recipeArtifactCoordinates=org.openrewrite.recipe:rewrite-migrate-java:RELEASE \
  -Drewrite.activeRecipes=org.openrewrite.java.migrate.UpgradeToJava25
# Spring Boot 4.0: recipe artifact org.openrewrite.recipe:rewrite-spring:RELEASE,
# recipe org.openrewrite.java.spring.boot4.UpgradeSpringBoot_4_0
```

Run on a clean branch, review the diff like any other change, then build and test.
