---
name: budget-and-spend-governor
description: Autonomous spend and token controller. Enforces immutable cost tracking, dynamic model routing (Haiku -> Sonnet -> Opus), fail-closed circuit breakers, and x402 agent payment policies.
---

# Budget & Spend Governor

Governs token burn rates, optimizes model tier routing, and enforces cryptographic spending controls for autonomous agents and machine payments (x402 protocol).

---

## 1. Dynamic Model Routing Matrix

Route tasks based on measurable complexity to minimize token expenditure:

- **Light Tier (Haiku)**: Quick file scans, git status checks, instinct extraction, lint error parsing (< 10k chars, < 5 files).
- **Standard Tier (Sonnet)**: Feature implementation, refactoring, unit test authoring, code reviews.
- **Deep Reasoning Tier (Opus)**: Complex system architecture, multi-agent contract synthesis, root-cause diagnosis of subtle concurrency/race conditions.

---

## 2. Immutable Cost Tracker Architecture

Cost state is strictly immutable. Every operation produces a new frozen record to prevent agents from manipulating their own budget state.

```python
from dataclasses import dataclass

@dataclass(frozen=True, slots=True)
class BudgetGovernor:
    max_session_budget_usd: float = 5.00
    spent_usd: float = 0.00
    token_ceiling: int = 1_000_000
    total_tokens: int = 0

    def record_usage(self, cost: float, tokens: int) -> "BudgetGovernor":
        new_spent = self.spent_usd + cost
        new_tokens = self.total_tokens + tokens
        if new_spent > self.max_session_budget_usd:
            raise RuntimeError(f"Spend limit ${self.max_session_budget_usd} exceeded!")
        return BudgetGovernor(
            self.max_session_budget_usd,
            new_spent,
            self.token_ceiling,
            new_tokens
        )
```

---

## 3. x402 Agent Payment Guardrails

When autonomous agents interact with HTTP 402 smart accounts (ERC-4337):
1. **Pre-Tool Fail-Closed Verification**: Confirm remaining per-task budget and recipient address allowlist before invoking payment execution.
2. **Orchestrator Policy Ceiling**: Spending limits are set by the outer host environment and cannot be modified by agent tool calls.
3. **Environment Isolation**: Subprocess environment variables are allowlisted; secrets and root credentials are never passed to payment workers.
