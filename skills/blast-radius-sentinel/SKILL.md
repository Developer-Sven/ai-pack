---
name: blast-radius-sentinel
description: Least-Agency security gate for autonomous agents. Enforces Meta's Agents Rule of Two, Fact-Forcing PreToolUse interception (GateGuard pattern), Directory Freezing, and Markdown exfiltration filtering.
---

# Blast Radius Sentinel (Least-Agency Security Gate)

Autonomous agents must operate under **Least Agency** constraints to prevent prompt injection, catastrophic file loss, and unauthorized external exfiltration.

---

## 1. Meta's "Rule of Two" Enforcement

Every autonomous turn evaluates whether it touches too many risk vectors simultaneously:

$$\text{Agency Score} = \mathbb{I}(\text{Untrusted Input}) + \mathbb{I}(\text{Sensitive Data}) + \mathbb{I}(\text{State Mutation / External Comms})$$

- **If $\text{Agency Score} \le 2$**: Autonomous execution is permitted.
- **If $\text{Agency Score} == 3$**: Mandatory Out-of-Band Human Confirmation gate before tool invocation.

---

## 2. Fact-Forcing Gate (`gateguard` protocol)

Never ask an LLM *"Are you sure?"* (models say "yes" >98% of the time). Follow the 3-stage factual gate:

1. **DENY**: Intercept the first `Edit`, `Write`, or destructive command (`rm`, `git reset`, `DROP`).
2. **FORCE FACTS**: Demand 4 concrete proofs before allowing execution:
   - Run Grep/Glob to list all files importing/referencing this module.
   - Show the exact data schema and field types.
   - Identify affected tests and public interfaces.
   - Quote the user's active instruction verbatim.
3. **ALLOW**: Authorize execution only after facts are injected into working memory.

---

## 3. Destructive Command & Exfiltration Interceptors

- **Hard-Blocked Commands**: `rm -rf /`, `git push --force`, `git reset --hard`, `DROP TABLE`, `chmod 777`.
- **Directory Freeze Mode**: Confine writes strictly to the target feature folder (e.g. `src/features/auth/**`).
- **Markdown Image Exfiltration Filter**: Strip remote image tags `![image](https://example.com/pixel.png)` from model output to block query-string credential leaks.
- **SSRF / Egress Defense**: Block cloud metadata (`169.254.169.254`) and private RFC 1918 subnets.
