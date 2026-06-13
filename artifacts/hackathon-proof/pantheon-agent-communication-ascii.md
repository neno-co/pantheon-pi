# Pantheon agent communication map

```text
                         SHORT-RUNNING WORK: edit in place, validate, ship

┌─────────────────────────────────────────────────────────────────────────────┐
│                                  ATHENA                                     │
│       primary builder-orchestrator: reads, edits, tests, and coordinates     │
│       directly; delegates only when specialization or review is needed       │
└───────┬──────────────┬──────────────┬──────────────┬──────────────┬────────┘
        │              │              │              │              │
        │              │              │              │              │
        ▼              ▼              ▼              ▼              ▼
┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐
│ Mnemosyne   │  │ Prometheus  │  │ Vulkanus    │  │ Dike        │  │ Argus       │
│ memory +    │  │ planning +  │  │ TDD /       │  │ verifier /  │  │ adversarial │
│ archaeology │  │ strategy    │  │ implementer │  │ judge       │  │ reviewer    │
└──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └─────────────┘  └──────┬──────┘
       │                │                │                                  │
       ▼                ▼                ▼                                  ▼
┌─────────────┐  ┌─────────────┐  ┌─────────────┐                    ┌─────────────┐
│ Research    │  │ Oracle      │  │ Oracle      │                    │ Hunter      │
│ agents      │  │ architecture│  │ blocked     │                    │ reviewers   │
│ locator /   │  │ counsel     │  │ tradeoffs   │                    │ security /  │
│ analyzer /  │  └─────────────┘  └─────────────┘                    │ tests / etc │
│ librarian   │                                                       └─────────────┘
└─────────────┘


                         LONG-RUNNING WORK: delegated multi-agent loop

┌─────────────────────────────────────────────────────────────────────────────┐
│                                   ZEUS                                      │
│       long-running orchestration: routes work, manages specialists,          │
│       resumes sessions, and keeps the delegation loop moving                 │
└───────┬──────────────┬──────────────┬──────────────┬──────────────┬────────┘
        │              │              │              │              │
        ▼              ▼              ▼              ▼              ▼
┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐
│ Mnemosyne   │  │ Prometheus  │  │ Vulkanus    │  │ Dike        │  │ Argus       │
│ system      │  │ phase plan  │  │ long task   │  │ contract    │  │ final gate  │
│ context     │  │ + sequence  │  │ implementer │  │ verifier    │  │ + hunters   │
└──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └─────────────┘  └──────┬──────┘
       │                │                │                                  │
       ▼                ▼                ▼                                  ▼
┌─────────────┐  ┌─────────────┐  ┌─────────────┐                    ┌─────────────┐
│ Research    │  │ Oracle      │  │ Oracle      │                    │ Hunter      │
│ agents      │  │ design      │  │ hard debug  │                    │ specialists │
└─────────────┘  └─────────────┘  └─────────────┘                    └─────────────┘


                         META-AGENT LOOP: improve Pantheon itself

┌─────────────────────┐       traces / spans / failures       ┌─────────────────────┐
│  Pantheon runs       │ ────────────────────────────────────► │     LangWatch       │
│  Athena / Zeus /     │                                      │  telemetry corpus   │
│  acpx sessions       │ ◄──────────────────────────────────── │                     │
└──────────┬──────────┘        evidence + run IDs              └──────────┬──────────┘
           │                                                              │
           │                                                              ▼
           │                                                   ┌─────────────────────┐
           │                                                   │     Meta-agent      │
           │                                                   │ after-action review │
           │                                                   │ trace mining        │
           │                                                   └──────────┬──────────┘
           │                                                              │
           │                                                              ▼
           │                                                   ┌─────────────────────┐
           │                                                   │ Harness changes     │
           └────────────────────────────────────────────────── │ session-first,     │
                     implemented back into Pantheon             │ resume-don't-restart│
                                                               │ richer telemetry   │
                                                               └─────────────────────┘
```

## How to read this

- **Athena** is the short-running primary builder. She edits in place, validates, and owns the immediate outcome, while still having access to every specialist agent.
- **Zeus** is the long-running orchestration pattern. He is useful when work needs extended delegation, multiple specialist sessions, resumability, and coordination over time.
- **Mnemosyne** provides memory and system archaeology; it can call narrower research agents.
- **Prometheus** plans complex phases and consults **Oracle** for architecture.
- **Vulkanus** implements larger or TDD-heavy work and escalates hard tradeoffs to **Oracle**.
- **Dike** verifies contracts and gates completion.
- **Argus** reviews adversarially and can fan out to hunter reviewers.
- **Meta-agent** reviews Pantheon’s own traces and proposes harness improvements.

## Pitch line

Pantheon is not one agent. It is a communication protocol between specialized agents — plus a meta-agent loop that uses telemetry to improve the protocol itself.
